import { useRef, useState } from "react";
import { chatImageSource } from "../../lib/chatImage";

export function ChatImage({ mimeType, data }: { mimeType: string; data: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  const src = chatImageSource(mimeType, data);
  if (!src || failed) return <p role="status" className="text-sm text-muted-foreground">Image unavailable: unsupported, oversized, or invalid image.</p>;
  return (
    <figure className="chat-image">
      <button type="button" aria-label="Enlarge agent image" onClick={() => dialog.current?.showModal()}>
        <img src={src} alt="Image returned by agent" loading="lazy" onError={() => setFailed(true)} />
        <span>Click to enlarge</span>
      </button>
      <dialog ref={dialog} aria-label="Agent image preview" className="image-preview" onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}>
        <button type="button" autoFocus onClick={() => dialog.current?.close()} className="pi-btn px-3 py-2">Close preview · Esc</button>
        <img src={src} alt="Enlarged image returned by agent" />
      </dialog>
    </figure>
  );
}
