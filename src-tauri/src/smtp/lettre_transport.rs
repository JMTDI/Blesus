use lettre::{
    message::{header::{ContentDisposition, ContentId, ContentType, HeaderName, HeaderValue, InReplyTo, References}, Attachment, Mailbox, Message, MessageBuilder, MultiPart, SinglePart},
    transport::smtp::{authentication::Credentials, client::Tls, AsyncSmtpTransport},
    AsyncTransport, Tokio1Executor,
};
use std::time::{SystemTime, UNIX_EPOCH};

use super::types::{
    OutgoingAttachment, OutgoingMessage, SaveToSent, SendResult, SmtpConfig, SmtpSecurity,
};
use crate::error::{Error, Result};

/// Encode a subject string for use as an RFC 2047 MIME header value.
///
/// If the string is ASCII it is returned unchanged (lettre passes it through
/// verbatim).  Otherwise every byte is placed into `=?UTF-8?B?...?=`
/// base64-encoded words of at most 45 raw bytes each.  Crucially, pairs of
/// Unicode regional-indicator characters (U+1F1E6–U+1F1FF, i.e. flag emoji)
/// are *never* split across word boundaries — splitting them causes email
/// clients that decode each word independently to show two isolated letters
/// instead of a country flag.
fn encode_subject_rfc2047(subject: &str) -> String {
    if subject.is_ascii() {
        return subject.to_string();
    }

    // 45 raw bytes → 60 base64 chars → 72-char encoded word (within RFC limit of 75).
    const MAX_BYTES: usize = 45;

    let chars: Vec<char> = subject.chars().collect();
    let mut words: Vec<String> = Vec::new();
    let mut chunk = Vec::<u8>::with_capacity(MAX_BYTES + 8);
    let mut buf = [0u8; 4];
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        let clen = c.encode_utf8(&mut buf).len();

        // Is this the first of a regional-indicator pair?
        let is_flag_start = ('\u{1F1E6}'..='\u{1F1FF}').contains(&c)
            && i + 1 < chars.len()
            && ('\u{1F1E6}'..='\u{1F1FF}').contains(&chars[i + 1]);

        let mut tmp = [0u8; 4];
        let need = if is_flag_start {
            clen + chars[i + 1].encode_utf8(&mut tmp).len()
        } else {
            clen
        };

        // Flush current chunk if adding `need` bytes would overflow it.
        if chunk.len() + need > MAX_BYTES && !chunk.is_empty() {
            words.push(format!("=?utf-8?b?{}?=", b64_encode(&chunk)));
            chunk.clear();
        }

        chunk.extend_from_slice(&buf[..clen]);
        i += 1;

        // For a flag pair, immediately add the second regional indicator to
        // keep both characters in the same encoded word.
        if is_flag_start {
            let c2 = chars[i];
            let clen2 = c2.encode_utf8(&mut buf).len();
            chunk.extend_from_slice(&buf[..clen2]);
            i += 1;
        }
    }

    if !chunk.is_empty() {
        words.push(format!("=?utf-8?b?{}?=", b64_encode(&chunk)));
    }

    words.join(" ")
}

/// Minimal standard Base64 encoder (RFC 4648 §4, with `=` padding).
fn b64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for ch in data.chunks(3) {
        let b0 = ch[0] as u32;
        let b1 = if ch.len() > 1 { ch[1] as u32 } else { 0 };
        let b2 = if ch.len() > 2 { ch[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if ch.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if ch.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

pub async fn test_connection(config: &SmtpConfig) -> Result<()> {
    let transport = build_transport(config)?;
    let ok = transport
        .test_connection()
        .await
        .map_err(|e| Error::Smtp(format!("test: {e}")))?;
    if !ok {
        return Err(Error::Smtp("server rejected test connection".into()));
    }
    Ok(())
}

pub async fn send(
    config: &SmtpConfig,
    outgoing: &OutgoingMessage,
    save_to_sent: Option<&SaveToSent>,
) -> Result<SendResult> {
    let transport = build_transport(config)?;
    let message = build_message(outgoing)?;
    // `formatted()` materialises the full RFC822 message once. We reuse the
    // same bytes for the IMAP APPEND below, so the Sent copy is byte-identical
    // to what went out via SMTP.
    let raw = message.formatted();

    let response = transport
        .send(message)
        .await
        .map_err(|e| Error::Smtp(format!("send: {e}")))?;

    let message_id = response
        .message()
        .next()
        .map(str::to_string);

    let imap_appended = if let Some(sent) = save_to_sent {
        // Best effort — never fail the send because the Sent copy couldn't be
        // appended. The mail is already out the door by this point.
        match crate::imap::client::append_message(
            &sent.imap,
            &sent.folder,
            &raw,
            &["\\Seen".to_string()],
        )
        .await
        {
            Ok(()) => Some(true),
            Err(e) => {
                log::warn!("APPEND to Sent folder {} failed: {e}", sent.folder);
                Some(false)
            }
        }
    } else {
        None
    };

    Ok(SendResult {
        message_id,
        imap_appended,
    })
}

fn build_transport(config: &SmtpConfig) -> Result<AsyncSmtpTransport<Tokio1Executor>> {
    let builder = match config.security {
        SmtpSecurity::Ssl => {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)
                .map_err(|e| Error::Smtp(format!("relay: {e}")))?
        }
        SmtpSecurity::StartTls => {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
                .map_err(|e| Error::Smtp(format!("starttls relay: {e}")))?
        }
        SmtpSecurity::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&config.host)
            .tls(Tls::None),
    };

    let creds = Credentials::new(config.username.clone(), config.password.clone());

    Ok(builder.port(config.port).credentials(creds).build())
}

pub fn build_message(outgoing: &OutgoingMessage) -> Result<Message> {
    let from: Mailbox = outgoing
        .from
        .parse()
        .map_err(|e| Error::Smtp(format!("parse from: {e}")))?;

    let encoded_subject = encode_subject_rfc2047(&outgoing.subject);
    let subject_hv = HeaderValue::dangerous_new_pre_encoded(
        HeaderName::new_from_ascii_str("Subject"),
        outgoing.subject.clone(),
        encoded_subject,
    );
    let mut builder: MessageBuilder = Message::builder().from(from).raw_header(subject_hv);

    for to in &outgoing.to {
        let addr: Mailbox = to
            .parse()
            .map_err(|e| Error::Smtp(format!("parse to: {e}")))?;
        builder = builder.to(addr);
    }
    for cc in &outgoing.cc {
        let addr: Mailbox = cc
            .parse()
            .map_err(|e| Error::Smtp(format!("parse cc: {e}")))?;
        builder = builder.cc(addr);
    }
    for bcc in &outgoing.bcc {
        let addr: Mailbox = bcc
            .parse()
            .map_err(|e| Error::Smtp(format!("parse bcc: {e}")))?;
        builder = builder.bcc(addr);
    }
    if let Some(reply_to) = &outgoing.reply_to {
        let addr: Mailbox = reply_to
            .parse()
            .map_err(|e| Error::Smtp(format!("parse reply-to: {e}")))?;
        builder = builder.reply_to(addr);
    }
    if let Some(irt) = &outgoing.in_reply_to {
        builder = builder.header(InReplyTo::from(irt.clone()));
    }
    if let Some(refs) = &outgoing.references {
        builder = builder.header(References::from(refs.clone()));
    }

    let body = build_body(&outgoing.html, &outgoing.text)?;

    let message = if outgoing.attachments.is_empty() {
        match body {
            MessageBody::Multi(mp) => builder.multipart(mp),
            MessageBody::Single(sp) => builder.singlepart(sp),
        }
    } else {
        let mut mixed = match body {
            MessageBody::Multi(mp) => MultiPart::mixed().multipart(mp),
            MessageBody::Single(sp) => MultiPart::mixed().singlepart(sp),
        };
        for a in &outgoing.attachments {
            mixed = mixed.singlepart(build_attachment_part(a)?);
        }
        builder.multipart(mixed)
    };

    message.map_err(|e| Error::Smtp(format!("build message: {e}")))
}

enum MessageBody {
    Multi(MultiPart),
    Single(SinglePart),
}

/// A single inline image extracted from an HTML body's `data:` URI.
struct InlineImage {
    cid: String,
    content_type: String,
    bytes: Vec<u8>,
}

/// Scan the HTML for `data:image/...;base64,...` URIs in img tags, extract
/// each one as an inline image with a generated Content-ID, and replace the
/// `src="data:..."` with `src="cid:<generated-id>"`. This is required for
/// Gmail (and many other clients) to render inline photos — Gmail strips
/// `data:` URIs in HTML email for security.
fn extract_inline_images(html: &str) -> (String, Vec<InlineImage>) {
    let mut out = String::with_capacity(html.len());
    let mut images: Vec<InlineImage> = Vec::new();
    let mut counter: u64 = 0;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    // Walk the HTML, replacing every `data:image/*;base64,XXXX` URI with a
    // generated `cid:` reference. We match on the literal prefix so we don't
    // need a regex dependency.
    let mut rest = html;
    while let Some(idx) = rest.find("data:image/") {
        out.push_str(&rest[..idx]);
        let candidate = &rest[idx..];
        // Parse the mime subtype (e.g. "jpeg", "png"). Stop at ';' or ',' or '"'.
        let after_prefix = &candidate["data:image/".len()..];
        let subtype_end = after_prefix
            .find(|c: char| c == ';' || c == ',' || c == '"' || c == '\'')
            .unwrap_or(after_prefix.len());
        let subtype = &after_prefix[..subtype_end];
        if subtype.is_empty() {
            // Not a real data URI — copy the literal and advance past `data:image/`.
            out.push_str(&candidate[.."data:image/".len()]);
            rest = &candidate["data:image/".len()..];
            continue;
        }
        // Find the comma that separates the header from the base64 payload.
        let comma_off = match candidate.find(',') {
            Some(c) => c,
            None => {
                // Malformed — preserve as-is.
                out.push_str(candidate);
                rest = "";
                break;
            }
        };
        let header = &candidate[..comma_off];
        // Only handle base64-encoded URIs (the common case for canvas/blob/paste).
        if !header.contains(";base64") {
            out.push_str(&candidate[..comma_off + 1]);
            rest = &candidate[comma_off + 1..];
            continue;
        }
        // Find the end of the base64 payload: quote, whitespace, or end-of-string.
        let payload_start = comma_off + 1;
        let payload_end_rel = candidate[payload_start..]
            .find(|c: char| c == '"' || c == '\'' || c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == '>')
            .unwrap_or(candidate.len() - payload_start);
        let b64_payload = &candidate[payload_start..payload_start + payload_end_rel];
        let bytes = match b64_decode(b64_payload) {
            Some(b) => b,
            None => {
                // Couldn't decode — leave the URI untouched.
                out.push_str(&candidate[..payload_start + payload_end_rel]);
                rest = &candidate[payload_start + payload_end_rel..];
                continue;
            }
        };
        // Generate a unique Content-ID for this image (with a host-like suffix
        // to satisfy RFC 2392 / RFC 5322 angle-addr-like syntax).
        counter += 1;
        let cid = format!("inline-{nanos}-{counter}@blesus.local");
        let ext = match subtype {
            "jpeg" | "jpg" => "jpeg",
            "png" => "png",
            "gif" => "gif",
            "webp" => "webp",
            "svg+xml" | "svg" => "svg+xml",
            other => other,
        };
        images.push(InlineImage {
            cid: cid.clone(),
            content_type: format!("image/{ext}"),
            bytes,
        });
        // Write the cid: replacement in place of the data: URI.
        out.push_str("cid:");
        out.push_str(&cid);
        rest = &candidate[payload_start + payload_end_rel..];
    }
    out.push_str(rest);
    (out, images)
}

/// Minimal Base64 decoder (RFC 4648 §4) — tolerates whitespace and missing
/// padding. Returns None on invalid input.
fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for ch in s.bytes() {
        let v: u32 = match ch {
            b'A'..=b'Z' => (ch - b'A') as u32,
            b'a'..=b'z' => (ch - b'a' + 26) as u32,
            b'0'..=b'9' => (ch - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

/// Build a SinglePart for an inline image with Content-ID and inline disposition.
fn build_inline_image_part(img: &InlineImage) -> Result<SinglePart> {
    let content_type = ContentType::parse(&img.content_type)
        .map_err(|e| Error::Smtp(format!("parse inline image content-type {}: {e}", img.content_type)))?;
    let cid_header = ContentId::from(format!("<{}>", img.cid));
    Ok(SinglePart::builder()
        .header(content_type)
        .header(cid_header)
        .header(ContentDisposition::inline())
        .body(img.bytes.clone()))
}

fn build_body(html: &Option<String>, text: &Option<String>) -> Result<MessageBody> {
    match (html, text) {
        (Some(h), Some(t)) => {
            let (h_rewritten, inline_images) = extract_inline_images(h);
            let html_part = SinglePart::builder()
                .header(ContentType::TEXT_HTML)
                .body(h_rewritten);
            let text_part = SinglePart::builder()
                .header(ContentType::TEXT_PLAIN)
                .body(t.clone());
            if inline_images.is_empty() {
                Ok(MessageBody::Multi(
                    MultiPart::alternative()
                        .singlepart(text_part)
                        .singlepart(html_part),
                ))
            } else {
                // Wrap HTML + inline images in multipart/related, then
                // combine with the text alternative.
                let mut related = MultiPart::related().singlepart(html_part);
                for img in &inline_images {
                    related = related.singlepart(build_inline_image_part(img)?);
                }
                Ok(MessageBody::Multi(
                    MultiPart::alternative()
                        .singlepart(text_part)
                        .multipart(related),
                ))
            }
        }
        (Some(h), None) => {
            let (h_rewritten, inline_images) = extract_inline_images(h);
            let html_part = SinglePart::builder()
                .header(ContentType::TEXT_HTML)
                .body(h_rewritten);
            if inline_images.is_empty() {
                Ok(MessageBody::Single(html_part))
            } else {
                let mut related = MultiPart::related().singlepart(html_part);
                for img in &inline_images {
                    related = related.singlepart(build_inline_image_part(img)?);
                }
                Ok(MessageBody::Multi(related))
            }
        }
        (None, Some(t)) => Ok(MessageBody::Single(
            SinglePart::builder()
                .header(ContentType::TEXT_PLAIN)
                .body(t.clone()),
        )),
        (None, None) => Err(Error::Smtp("message must have html or text body".into())),
    }
}

fn build_attachment_part(a: &OutgoingAttachment) -> Result<SinglePart> {
    let bytes = std::fs::read(&a.path)?;
    let ct_str = a.content_type.as_deref().unwrap_or("application/octet-stream");
    let content_type = ContentType::parse(ct_str)
        .map_err(|e| Error::Smtp(format!("parse content-type {ct_str}: {e}")))?;
    Ok(Attachment::new(a.filename.clone()).body(bytes, content_type))
}
