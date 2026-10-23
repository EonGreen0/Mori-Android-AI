use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

const TOKEN_FILE: &str = "sync-token.dpapi";

fn credential_path() -> Result<std::path::PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .ok_or("Local application data directory is unavailable")?;
    Ok(std::path::PathBuf::from(local_app_data)
        .join("Mori")
        .join(TOKEN_FILE))
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.len() < 20
        || token.len() > 512
        || !token.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'+' | b'/' | b'=')
        })
    {
        return Err("Personal sync credential format is invalid".into());
    }
    Ok(())
}

pub fn available() -> bool {
    read_sync_token().is_ok()
}

pub fn read_sync_token() -> Result<String, String> {
    let stored = std::fs::read_to_string(credential_path()?)
        .map_err(|_| "Personal sync credential is unavailable".to_string())?;
    let hex = stored.trim().as_bytes();
    if hex.is_empty() || hex.len() > 8192 || hex.len() % 2 != 0 {
        return Err("Personal sync credential storage is invalid".into());
    }
    let mut encrypted = Vec::with_capacity(hex.len() / 2);
    for pair in hex.chunks_exact(2) {
        let byte = std::str::from_utf8(pair)
            .ok()
            .and_then(|digits| u8::from_str_radix(digits, 16).ok())
            .ok_or("Personal sync credential storage is invalid")?;
        encrypted.push(byte);
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    }
    .map_err(|_| "Could not decrypt current-user sync credential".to_string())?;

    let decoded = if output.pbData.is_null()
        || output.cbData == 0
        || output.cbData > 2048
        || output.cbData % 2 != 0
    {
        Err("Personal sync credential plaintext is invalid".to_string())
    } else {
        let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
        let mut units = bytes
            .chunks_exact(2)
            .map(|part| u16::from_le_bytes([part[0], part[1]]))
            .collect::<Vec<_>>();
        let decoded = String::from_utf16(&units)
            .map_err(|_| "Personal sync credential encoding is invalid".to_string());
        units.fill(0);
        decoded
    };
    unsafe {
        if !output.pbData.is_null() {
            std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
            let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        }
    }
    let token = decoded?;
    validate_token(&token)?;
    Ok(token)
}

pub fn store_sync_token(token: &str) -> Result<(), String> {
    validate_token(token)?;
    let mut plaintext = token
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let result = unsafe {
        CryptProtectData(
            &input,
            windows::core::PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    plaintext.fill(0);
    result.map_err(|_| "Could not encrypt current-user sync credential".to_string())?;

    if output.pbData.is_null() || output.cbData == 0 || output.cbData > 4096 {
        unsafe {
            if !output.pbData.is_null() {
                std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
                let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
            }
        }
        return Err("Encrypted sync credential is invalid".into());
    }

    let encrypted = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let mut encoded = String::with_capacity(encrypted.len() * 2);
    for byte in encrypted {
        use std::fmt::Write;
        let _ = write!(encoded, "{byte:02x}");
    }
    unsafe {
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
    }

    let path = credential_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "Could not create sync credential directory".to_string())?;
    }
    std::fs::write(path, encoded)
        .map_err(|_| "Could not store personal sync credential".to_string())?;
    Ok(())
}

pub fn clear_sync_token() -> Result<(), String> {
    let path = credential_path()?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not clear personal sync credential".into()),
    }
}

pub fn copy_sync_token_to_clipboard() -> Result<(), String> {
    use windows::ApplicationModel::DataTransfer::{Clipboard, DataPackage};
    use windows::core::HSTRING;

    let token = read_sync_token()?;
    let package = DataPackage::new().map_err(|_| "Could not initialize clipboard data".to_string())?;
    package
        .SetText(&HSTRING::from(token))
        .map_err(|_| "Could not copy sync credential".to_string())?;
    Clipboard::SetContent(&package).map_err(|_| "Could not copy sync credential".to_string())?;
    Clipboard::Flush().map_err(|_| "Could not persist sync credential in clipboard".to_string())?;
    Ok(())
}
