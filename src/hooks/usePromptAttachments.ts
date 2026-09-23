import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { readImageFile } from "../lib/ipc";
import {
  attachmentFromFile,
  fileName,
  imageMimeForPath,
  IMAGE_EXTENSIONS,
  registerAttachment,
  rejectAttachment,
  rejectionMessage,
  type Attachment,
} from "../lib/attachments";

interface Params {
  /** Only the visible chat accepts drops; hidden panes share the same webview. */
  active: boolean;
  /** The agent advertised `promptCapabilities.image`. */
  supportsImages: boolean;
  agentName: string;
  /** Surfaces a rejection in the transcript instead of failing silently. */
  note: (text: string) => void;
}

/**
 * Pending images for the next prompt, fed by three sources — clipboard paste
 * (browser Files), Tauri drag-drop (paths), and the native file picker
 * (paths). Every source funnels through the same validation and the same
 * capability gate, so the composer only ever holds sendable attachments.
 */
export function usePromptAttachments({ active, supportsImages, agentName, note }: Params) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  const gate = useCallback(() => {
    if (supportsImages) return true;
    note(`${agentName} does not accept images over ACP.`);
    return false;
  }, [supportsImages, agentName, note]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || !gate()) return;
      for (const file of files) {
        const reason = rejectAttachment({ mimeType: file.type, bytes: file.size });
        if (reason) {
          note(rejectionMessage(file.name || "Pasted file", reason));
          continue;
        }
        try {
          const attachment = await attachmentFromFile(file);
          setAttachments((current) => [...current, attachment]);
        } catch (cause) {
          note(`Could not read ${file.name}: ${String(cause)}`);
        }
      }
    },
    [gate, note],
  );

  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || !gate()) return;
      for (const path of paths) {
        const name = fileName(path);
        if (!imageMimeForPath(path)) {
          note(rejectionMessage(name, "not-image"));
          continue;
        }
        try {
          const file = await readImageFile(path);
          const ref = registerAttachment(file);
          setAttachments((current) => [...current, { ...ref, data: file.data }]);
        } catch (cause) {
          note(`Could not attach ${name}: ${String(cause)}`);
        }
      }
    },
    [gate, note],
  );

  const pick = useCallback(async () => {
    if (!gate()) return;
    const selection = await open({
      multiple: true,
      title: "Attach images",
      filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
    });
    if (!selection) return;
    await addPaths(Array.isArray(selection) ? selection : [selection]);
  }, [gate, addPaths]);

  const remove = useCallback(
    (id: string) => setAttachments((current) => current.filter((a) => a.id !== id)),
    [],
  );
  const clear = useCallback(() => setAttachments([]), []);

  // Tauri intercepts OS file drops (HTML5 drop events never see the paths), so
  // listen on the webview and hand the paths to the same reader as the picker.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!activeRef.current) return;
        const { payload } = event;
        if (payload.type === "enter" || payload.type === "over") setDragging(true);
        else if (payload.type === "leave") setDragging(false);
        else if (payload.type === "drop") {
          setDragging(false);
          void addPaths(payload.paths);
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addPaths]);

  return { attachments, dragging, addFiles, addPaths, pick, remove, clear };
}
