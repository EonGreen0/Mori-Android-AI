//! Desktop clipboard images: copy owned bytes while locked, then encode off the clipboard.
use windows::core::w;
use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
    OpenClipboard, RegisterClipboardFormatW,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const CF_DIB: u32 = 8;
const CF_DIBV5: u32 = 17;

pub enum Snapshot {
    Busy,
    Unchanged,
    NoImage,
    Image(Vec<u8>),
}

pub fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

struct ClipboardLock;
impl Drop for ClipboardLock {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

fn copy_global(handle: HANDLE) -> Result<Vec<u8>, String> {
    unsafe {
        let global = HGLOBAL(handle.0);
        let size = GlobalSize(global);
        if size == 0 || size > MAX_BYTES {
            return Err("clipboard_size: 图片为空或超过64MB".into());
        }
        let pointer = GlobalLock(global);
        if pointer.is_null() {
            return Err(format!(
                "clipboard_lock: {}",
                windows::core::Error::from_win32()
            ));
        }
        // Clipboard owns the handle. Only copy/unlock; never free it.
        let bytes = std::slice::from_raw_parts(pointer.cast::<u8>(), size).to_vec();
        let _ = GlobalUnlock(global);
        Ok(bytes)
    }
}

pub fn read(previous_sequence: Option<u32>) -> Result<Snapshot, String> {
    let (bytes, dib) = {
        if unsafe { OpenClipboard(None) }.is_err() {
            return Ok(Snapshot::Busy);
        }
        let _lock = ClipboardLock;
        // Check under the lock: delayed rendering/another app must not race the baseline check.
        if previous_sequence == Some(sequence()) {
            return Ok(Snapshot::Unchanged);
        }
        let png = unsafe { RegisterClipboardFormatW(w!("PNG")) };
        let mut payload = None;
        if png != 0 && unsafe { IsClipboardFormatAvailable(png) }.is_ok() {
            let handle =
                unsafe { GetClipboardData(png) }.map_err(|e| format!("clipboard_png: {e}"))?;
            let bytes = copy_global(handle)?;
            if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                payload = Some((bytes, false));
            }
        }
        if payload.is_none() {
            for format in [CF_DIBV5, CF_DIB] {
                if unsafe { IsClipboardFormatAvailable(format) }.is_ok() {
                    let handle = unsafe { GetClipboardData(format) }
                        .map_err(|e| format!("clipboard_bitmap: {e}"))?;
                    payload = Some((copy_global(handle)?, true));
                    break;
                }
            }
        }
        match payload {
            Some(value) => value,
            None => return Ok(Snapshot::NoImage),
        }
    };
    Ok(Snapshot::Image(if dib {
        dib_to_png(&bytes)?
    } else {
        bytes
    }))
}

fn dib_to_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let invalid = || "clipboard_bitmap: 不支持或损坏的位图".to_string();
    if bytes.len() < 40 {
        return Err(invalid());
    }
    let u32_at = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
    let header = u32_at(0) as usize;
    if ![40, 108, 124].contains(&header) || bytes.len() < header {
        return Err(invalid());
    }
    let width = u32_at(4) as i32;
    let signed_height = u32_at(8) as i32;
    let bits = u16::from_le_bytes(bytes[14..16].try_into().unwrap());
    let planes = u16::from_le_bytes(bytes[12..14].try_into().unwrap());
    let compression = u32_at(16);
    if width <= 0
        || signed_height == 0
        || signed_height == i32::MIN
        || planes != 1
        || ![24, 32].contains(&bits)
        || ![0, 3].contains(&compression)
        || (compression == 3 && bits != 32)
    {
        return Err(invalid());
    }
    let masks_size = if header == 40 && compression == 3 {
        12
    } else {
        0
    };
    if bytes.len() < header + masks_size {
        return Err(invalid());
    }
    if compression == 3
        && (u32_at(40), u32_at(44), u32_at(48)) != (0x00ff0000, 0x0000ff00, 0x000000ff)
    {
        return Err(invalid());
    }
    let width = width as usize;
    let height = signed_height.unsigned_abs() as usize;
    let channels = bits as usize / 8;
    let stride = width
        .checked_mul(channels)
        .and_then(|n| n.checked_add(3))
        .map(|n| n & !3)
        .ok_or_else(invalid)?;
    let rgb_size = width
        .checked_mul(height)
        .and_then(|n| n.checked_mul(3))
        .filter(|n| *n <= MAX_BYTES)
        .ok_or_else(invalid)?;
    let palette_size = (u32_at(32) as usize).checked_mul(4).ok_or_else(invalid)?;
    let offset = header
        .checked_add(masks_size)
        .and_then(|n| n.checked_add(palette_size))
        .ok_or_else(invalid)?;
    let end = stride
        .checked_mul(height)
        .and_then(|n| n.checked_add(offset))
        .ok_or_else(invalid)?;
    if end > bytes.len() {
        return Err(invalid());
    }
    let mut rgb = vec![0; rgb_size];
    for y in 0..height {
        let source_y = if signed_height < 0 { y } else { height - 1 - y };
        for x in 0..width {
            let source = offset + source_y * stride + x * channels;
            let target = (y * width + x) * 3;
            // BI_RGB alpha is often zero/uninitialized: desktop screenshots are opaque.
            rgb[target..target + 3].copy_from_slice(&[
                bytes[source + 2],
                bytes[source + 1],
                bytes[source],
            ]);
        }
    }
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("clipboard_encode: {e}"))?;
        writer
            .write_image_data(&rgb)
            .map_err(|e| format!("clipboard_encode: {e}"))?;
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dib(bits: u16, height: i32, header: usize, compression: u32, pixels: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0; header];
        bytes[0..4].copy_from_slice(&(header as u32).to_le_bytes());
        bytes[4..8].copy_from_slice(&1i32.to_le_bytes());
        bytes[8..12].copy_from_slice(&height.to_le_bytes());
        bytes[12..14].copy_from_slice(&1u16.to_le_bytes());
        bytes[14..16].copy_from_slice(&bits.to_le_bytes());
        bytes[16..20].copy_from_slice(&compression.to_le_bytes());
        if compression == 3 {
            if header == 40 {
                bytes.extend_from_slice(&[0; 12]);
            }
            for (i, mask) in [0x00ff0000u32, 0x0000ff00, 0x000000ff].iter().enumerate() {
                bytes[40 + i * 4..44 + i * 4].copy_from_slice(&mask.to_le_bytes());
            }
        }
        bytes.extend_from_slice(pixels);
        bytes
    }
    fn decode(bytes: Vec<u8>) -> Vec<u8> {
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        let mut pixels = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut pixels).unwrap();
        assert_eq!(info.color_type, png::ColorType::Rgb);
        pixels.truncate(info.buffer_size());
        pixels
    }
    #[test]
    fn bitmap_rows_colors_and_zero_alpha_are_preserved() {
        assert_eq!(
            decode(dib_to_png(&dib(24, 2, 40, 0, &[255, 0, 0, 0, 0, 0, 255, 0])).unwrap()),
            [255, 0, 0, 0, 0, 255]
        );
        for header in [40, 108, 124] {
            assert_eq!(
                decode(dib_to_png(&dib(32, -2, header, 3, &[0, 0, 255, 0, 255, 0, 0, 0])).unwrap()),
                [255, 0, 0, 0, 0, 255]
            );
        }
        assert_eq!(
            decode(dib_to_png(&dib(32, -1, 40, 0, &[12, 34, 56, 0])).unwrap()),
            [56, 34, 12]
        );
    }
    #[test]
    fn malformed_and_oversized_bitmaps_fail_without_allocating() {
        assert!(dib_to_png(&[0; 39]).is_err());
        let mut bytes = dib(24, 1, 40, 0, &[0; 4]);
        bytes[4..8].copy_from_slice(&i32::MAX.to_le_bytes());
        assert!(dib_to_png(&bytes).is_err());
        assert!(dib_to_png(&dib(32, 2, 40, 0, &[0; 4])).is_err());
        let mut bytes = dib(32, 1, 124, 3, &[0; 4]);
        bytes[40..44].copy_from_slice(&1u32.to_le_bytes());
        assert!(dib_to_png(&bytes).is_err());
    }
    #[test]
    fn native_memory_copy_owns_bytes_without_touching_clipboard() {
        use windows::Win32::Foundation::GlobalFree;
        use windows::Win32::System::Memory::{GlobalAlloc, GMEM_MOVEABLE};
        unsafe {
            let allocation = GlobalAlloc(GMEM_MOVEABLE, 4).unwrap();
            let pointer = GlobalLock(allocation).cast::<u8>();
            assert!(!pointer.is_null());
            std::ptr::copy_nonoverlapping([1u8, 2, 3, 4].as_ptr(), pointer, 4);
            let _ = GlobalUnlock(allocation);
            let copied = copy_global(HANDLE(allocation.0)).unwrap();
            // GlobalFree returns NULL on success (the generated HANDLE wrapper reports Err(0)).
            let _ = GlobalFree(Some(allocation));
            assert_eq!(&copied[..4], [1, 2, 3, 4]);
        }
    }
}
