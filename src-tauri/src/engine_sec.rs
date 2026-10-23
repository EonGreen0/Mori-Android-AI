// Protected under GNU General Public License v3.0.
// All rights reserved (C) 2026 coflyn.

extern "C" {
    fn mori_get_engine_key(
        challenge: *const std::ffi::c_char,
        out_hex: *mut std::ffi::c_char,
        max_len: i32,
    ) -> i32;
}

pub fn get_key(challenge: &str) -> Result<String, String> {
    let mut buf = [0u8; 65];
    let c_chal = std::ffi::CString::new(challenge).map_err(|e| e.to_string())?;
    let res = unsafe {
        mori_get_engine_key(
            c_chal.as_ptr(),
            buf.as_mut_ptr() as *mut std::ffi::c_char,
            65,
        )
    };
    if res == 0 {
        let hex_str = std::str::from_utf8(&buf[..64]).map_err(|e| e.to_string())?;
        Ok(hex_str.to_string())
    } else {
        Err("Mori Engine: Native security verification failed in core library.".into())
    }
}
