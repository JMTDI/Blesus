import { useMemo, useState } from "react";
import {
  Wrench,
  Merge,
  Scissors,
  Trash2,
  Check,
  X,
  Mail,
  CornerUpLeft,
  FolderInput,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useThreadRepairStore, type RepairItem } from "@/stores/threadRepair";
import { useComposerStore } from "@/stores/composer";
import { useAccountsStore } from "@/stores/accounts";
import { formatDateStack } from "@/lib/time";

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function ThreadRepairView() {
  const items = useThreadRepairStore((s) => s.items);
  const selectedIds = useThreadRepairStore((s) => s.selectedIds);
  const toggleSelect = useThreadRepairStore((s) => s.toggleSelect);
  const clearSelection = useThreadRepairStore((s) => s.clearSelection);
  const mergeSelected = useThreadRepairStore((s) => s.mergeSelected);
  const removeItem = useThreadRepairStore((s) => s.removeItem);
  const removeGroup = useThreadRepairStore((s) => s.removeGroup);
  const unmergeGroup = useThreadRepairStore((s) => s.unmergeGroup);
  const moveBack = useThreadRepairStore((s) => s.moveBack);

  /** Partition items into merged groups + standalone singletons */
  const { groups, standalone } = useMemo(() => {
    const groupMap = new Map<string, RepairItem[]>();
    const standalone: RepairItem[] = [];
    for (const item of items) {
      if (item.groupId) {
        const list = groupMap.get(item.groupId) ?? [];
        list.push(item);
        groupMap.set(item.groupId, list);
      } else {
        standalone.push(item);
      }
    }
    return { groups: groupMap, standalone };
  }, [items]);

  const hasSelection = selectedIds.length > 0;
  const canMerge = selectedIds.length >= 2;

  if (items.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-col h-full bg-base overflow-hidden">
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0"
        style={{ borderColor: "var(--border-soft)", background: "var(--bg-raised)" }}
      >
        <Wrench size={15} className="text-muted" />
        <span className="text-[13px] font-semibold text-primary flex-1">
          Thread Repair
        </span>

        {hasSelection && (
          <>
            <span className="text-[12px] text-muted">
              {selectedIds.length} selected
            </span>
            <ToolbarButton
              disabled={!canMerge}
              title={canMerge ? "Merge selected into one thread" : "Select at least 2 threads to merge"}
              onClick={() => void mergeSelected()}
            >
              <Merge size={14} />
              Merge
            </ToolbarButton>
            <ToolbarButton
              title="Remove selected from Thread Repair"
              danger
              onClick={() => {
                for (const id of selectedIds) void removeItem(id);
                clearSelection();
              }}
            >
              <Trash2 size={14} />
              Remove
            </ToolbarButton>
            <ToolbarButton title="Clear selection" onClick={clearSelection}>
              <X size={14} />
            </ToolbarButton>
          </>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">

        {/* Merged groups */}
        {Array.from(groups.entries()).map(([groupId, groupItems]) => (
          <MergedGroup
            key={groupId}
            groupId={groupId}
            items={groupItems}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onUnmerge={() => void unmergeGroup(groupId)}
            onRemove={() => void removeGroup(groupId)}
          />
        ))}

        {/* Standalone items */}
        {standalone.length > 0 && (
          <div>
            {groups.size > 0 && (
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-2 px-1">
                Unmerged threads
              </p>
            )}
            <div
              className="rounded-lg border overflow-hidden"
              style={{ borderColor: "var(--border-strong)" }}
            >
              {standalone.map((item, idx) => (
                <RepairRow
                  key={item.id}
                  item={item}
                  checked={selectedIds.includes(item.id)}
                  onToggle={() => toggleSelect(item.id)}
                  onRemove={() => void removeItem(item.id)}
                  onMoveBack={(dest) => void moveBack(item.id, dest)}
                  hasBorder={idx < standalone.length - 1}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Merged group card
// ---------------------------------------------------------------------------

function MergedGroup({
  groupId: _groupId,
  items,
  selectedIds,
  onToggleSelect,
  onUnmerge,
  onRemove,
}: {
  groupId: string;
  items: RepairItem[];
  selectedIds: number[];
  onToggleSelect: (id: number) => void;
  onUnmerge: () => void;
  onRemove: () => void;
}) {
  const openComposeWith = useComposerStore((s) => s.openComposeWith);
  const accounts = useAccountsStore((s) => s.accounts);

  function forwardMerged() {
    const subjects = [...new Set(items.map((i) => i.subject))].join(" / ");
    const body = items
      .map(
        (i) =>
          `<p><strong>${i.subject}</strong><br><em>(thread added ${new Date(i.addedAt * 1000).toLocaleDateString()})</em></p>`,
      )
      .join("<hr>");
    openComposeWith({ subject: `Fwd: ${subjects}`, bodyHtml: body });
  }

  const sortedItems = [...items].sort((a, b) => b.addedAt - a.addedAt);
  const accountColors = new Map(accounts.map((a) => [a.id, a.color ?? "#888"]));

  return (
    <div>
      {/* Group header */}
      <div className="flex items-center gap-2 mb-1.5 px-1">
        <div
          className="h-2 w-2 rounded-full shrink-0"
          style={{ background: "var(--accent)" }}
        />
        <span className="text-[11.5px] font-semibold text-primary flex-1">
          Merged group · {items.length} thread{items.length !== 1 ? "s" : ""}
        </span>
        <GroupAction title="Forward as one email" onClick={forwardMerged}>
          <Mail size={13} />
        </GroupAction>
        <GroupAction title="Unmerge — split back into individual threads" onClick={onUnmerge}>
          <Scissors size={13} />
        </GroupAction>
        <GroupAction title="Remove entire group" danger onClick={onRemove}>
          <Trash2 size={13} />
        </GroupAction>
      </div>

      {/* Items */}
      <div
        className="rounded-lg border overflow-hidden"
        style={{
          borderColor: "var(--accent)",
          boxShadow: "0 0 0 1px var(--accent)",
        }}
      >
        {sortedItems.map((item, idx) => (
          <RepairRow
            key={item.id}
            item={item}
            checked={selectedIds.includes(item.id)}
            onToggle={() => onToggleSelect(item.id)}
            onRemove={() => {/* individual removal inside a group not exposed — use group remove */}}
            onMoveBack={() => { /* not available inside merged group */ }}
            hasBorder={idx < sortedItems.length - 1}
            accentColor={accountColors.get(item.accountId)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single thread row
// ---------------------------------------------------------------------------

function RepairRow({
  item,
  checked,
  onToggle,
  onRemove,
  onMoveBack,
  hasBorder,
  accentColor,
}: {
  item: RepairItem;
  checked: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onMoveBack: (destFolderPath: string) => void;
  hasBorder: boolean;
  accentColor?: string;
}) {
  const { primary: dateStr } = formatDateStack(item.addedAt * 1000);
  const folders = useAccountsStore((s) => s.folders);
  const folder = folders.find((f) => f.id === item.folderId);
  const folderLabel = item.originalFolderPath
    ? (item.originalFolderPath.split(/[\/. \\]/).filter(Boolean).pop() ?? item.originalFolderPath)
    : (folder ? folder.name : "Unknown folder");

  /** Folders available for this account (for the Move To picker) */
  const accountFolders = folders.filter((f) => f.accountId === item.accountId);

  const [showPicker, setShowPicker] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");

  const filteredFolders = pickerQuery.trim()
    ? accountFolders.filter((f) =>
        f.name.toLowerCase().includes(pickerQuery.toLowerCase()) ||
        f.path.toLowerCase().includes(pickerQuery.toLowerCase()),
      )
    : accountFolders;

  const canMoveBack = !!item.messageId;

  return (
    <div
      className={cn(
        "flex flex-col transition-colors",
        checked ? "bg-selected" : "hover:bg-hover",
        hasBorder && "border-b",
      )}
      style={hasBorder ? { borderColor: "var(--border-soft)" } : undefined}
    >
      {/* Main row */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* Checkbox */}
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
            checked
              ? "border-accent bg-accent text-white"
              : "border-strong bg-base text-transparent hover:border-accent",
          )}
          style={checked ? { background: "var(--accent)", borderColor: "var(--accent)" } : undefined}
          aria-label={checked ? "Deselect" : "Select"}
        >
          <Check size={11} strokeWidth={3} />
        </button>

        {/* Account color dot */}
        {accentColor && (
          <span
            className="h-2 w-2 rounded-full shrink-0"
            style={{ background: accentColor }}
          />
        )}

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-primary truncate">{item.subject}</p>
          <p className="text-[11.5px] text-muted truncate">
            {canMoveBack ? `From: ${folderLabel}` : folderLabel}
          </p>
        </div>

        <span className="text-[11.5px] text-muted tabular-nums shrink-0">{dateStr}</span>

        {/* Move back to original */}
        {canMoveBack && item.originalFolderPath && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onMoveBack(item.originalFolderPath); }}
            title={`Move back to ${folderLabel}`}
            className="flex h-6 w-6 items-center justify-center rounded text-muted hover:text-primary hover:bg-hover transition-colors shrink-0"
          >
            <CornerUpLeft size={13} />
          </button>
        )}

        {/* Move to folder picker toggle */}
        {canMoveBack && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowPicker((v) => !v); setPickerQuery(""); }}
            title="Move to folder…"
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded transition-colors shrink-0",
              showPicker ? "text-primary bg-hover" : "text-muted hover:text-primary hover:bg-hover",
            )}
          >
            <FolderInput size={13} />
          </button>
        )}

        {/* Remove button */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove from Thread Repair"
          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:text-primary hover:bg-hover transition-colors shrink-0"
        >
          <X size={12} />
        </button>
      </div>

      {/* Inline folder picker */}
      {showPicker && (
        <div
          className="mx-3 mb-2.5 rounded-md border overflow-hidden"
          style={{ borderColor: "var(--border-strong)", background: "var(--bg-base)" }}
        >
          <input
            autoFocus
            type="text"
            placeholder="Search folders…"
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            className="w-full px-3 py-1.5 text-[12px] bg-transparent border-b outline-none text-primary placeholder:text-muted"
            style={{ borderColor: "var(--border-soft)" }}
            onKeyDown={(e) => { if (e.key === "Escape") setShowPicker(false); }}
          />
          <div className="max-h-40 overflow-y-auto">
            {filteredFolders.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-muted">No folders found</p>
            ) : (
              filteredFolders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-[12px] text-primary hover:bg-hover transition-colors"
                  onClick={() => {
                    setShowPicker(false);
                    onMoveBack(f.path);
                  }}
                >
                  {f.name}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function ToolbarButton({
  children,
  onClick,
  disabled,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] font-medium transition-colors",
        disabled
          ? "text-disabled cursor-not-allowed"
          : danger
            ? "text-secondary hover:bg-hover hover:text-[color:var(--color-danger)]"
            : "text-secondary hover:bg-hover hover:text-primary",
      )}
    >
      {children}
    </button>
  );
}

function GroupAction({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded text-muted transition-colors",
        danger
          ? "hover:text-[color:var(--color-danger)] hover:bg-hover"
          : "hover:text-primary hover:bg-hover",
      )}
    >
      {children}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8 h-full bg-base">
      <div
        className="h-14 w-14 rounded-full flex items-center justify-center"
        style={{ background: "var(--accent-soft)" }}
      >
        <Wrench size={22} className="text-accent" />
      </div>
      <div>
        <p className="text-[14px] font-semibold text-primary">Thread Repair is empty</p>
        <p className="text-[12.5px] text-muted mt-1 max-w-xs">
          Right-click any conversation and choose{" "}
          <strong>Add to Thread Repair</strong> to collect mis-threaded emails here.
          Then select multiple and hit <strong>Merge</strong>.
        </p>
      </div>
    </div>
  );
}
