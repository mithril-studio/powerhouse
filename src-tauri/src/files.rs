//! Local files the user hands to an agent (drag-drop or file picker). The
//! webview cannot read arbitrary paths itself, so the bytes cross the IPC
//! boundary base64-encoded, ready for an ACP `image` content block.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::path::Path;

/// Mirrors `MAX_IMAGE_BYTES` in `src/lib/attachments.ts`.
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    pub name: String,
    pub mime_type: String,
    pub data: String,
    pub bytes: u64,
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        _ => return None,
    })
}

/// Reads an image from disk as base64. Non-images and oversized files are
/// refused here so the UI never holds a payload it cannot send.
#[tauri::command]
pub fn read_image_file(path: String) -> Result<ImageFile, String> {
    let path = Path::new(&path);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "image".to_string());
    let mime_type = image_mime(path).ok_or_else(|| format!("{name} is not an image"))?;
    let bytes = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if bytes > MAX_IMAGE_BYTES {
        return Err(format!("{name} is larger than 10 MB"));
    }
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(ImageFile {
        name,
        mime_type: mime_type.to_string(),
        data: STANDARD.encode(raw),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_by_extension_is_case_insensitive() {
        assert_eq!(image_mime(Path::new("/a/Shot.PNG")), Some("image/png"));
        assert_eq!(image_mime(Path::new("/a/photo.JPEG")), Some("image/jpeg"));
        assert_eq!(image_mime(Path::new("/a/notes.txt")), None);
        assert_eq!(image_mime(Path::new("/a/noext")), None);
    }

    #[test]
    fn refuses_non_images_and_reads_images() {
        let dir = std::env::temp_dir().join(format!("ph-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let txt = dir.join("a.txt");
        std::fs::write(&txt, b"hi").unwrap();
        assert!(read_image_file(txt.to_string_lossy().to_string()).is_err());

        let png = dir.join("a.png");
        std::fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
        let file = read_image_file(png.to_string_lossy().to_string()).unwrap();
        assert_eq!(file.mime_type, "image/png");
        assert_eq!(file.bytes, 4);
        assert_eq!(file.data, "iVBORw==");
        std::fs::remove_dir_all(&dir).ok();
    }
}
