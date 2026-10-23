use std::fs::{self, File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// A unique output path reserved with create_new for the lifetime of a download.
/// Other concurrent downloads will see the placeholder and choose another name.
pub struct DownloadTarget {
    path: PathBuf,
    reservation: Option<File>,
    committed: bool,
}

impl DownloadTarget {
    pub fn reserve(directory: &Path, stem: &str, extension: &str) -> io::Result<Self> {
        let mut suffix = 0u64;
        loop {
            let filename = if suffix == 0 {
                format!("{stem}.{extension}")
            } else {
                format!("{stem}_{suffix}.{extension}")
            };
            let path = directory.join(filename);
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        reservation: Some(file),
                        committed: false,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    suffix = suffix.checked_add(1).ok_or_else(|| {
                        io::Error::new(io::ErrorKind::AlreadyExists, "no unique filename available")
                    })?;
                }
                Err(error) => return Err(error),
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Clear any previous candidate response while retaining the reservation.
    pub fn reset(&mut self) -> io::Result<()> {
        let file = self
            .reservation
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "download target is closed"))?;
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        file.flush()
    }

    pub fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.reset()?;
        let file = self
            .reservation
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "download target is closed"))?;
        file.write_all(bytes)?;
        file.flush()
    }

    pub fn has_bytes(&self) -> bool {
        self.reservation
            .as_ref()
            .and_then(|file| file.metadata().ok())
            .is_some_and(|metadata| metadata.len() > 0)
    }

    /// Keep the completed output after releasing the reservation handle.
    pub fn commit(mut self) -> PathBuf {
        self.committed = true;
        self.reservation.take();
        self.path.clone()
    }
}

impl Drop for DownloadTarget {
    fn drop(&mut self) {
        self.reservation.take();
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::DownloadTarget;
    use std::fs;
    use std::io;
    use std::process::Command;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory() -> io::Result<std::path::PathBuf> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "mori-download-target-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&directory)?;
        Ok(directory)
    }

    #[test]
    fn concurrent_reservations_keep_distinct_downloads() -> io::Result<()> {
        const DOWNLOADS: usize = 12;
        let directory = temporary_directory()?;
        let barrier = Arc::new(Barrier::new(DOWNLOADS));
        let workers = (0..DOWNLOADS)
            .map(|index| {
                let directory = directory.clone();
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || -> io::Result<(std::path::PathBuf, Vec<u8>)> {
                    let payload = format!("download-{index}").into_bytes();
                    let mut target = DownloadTarget::reserve(&directory, "same-title", "mp4")?;
                    barrier.wait();
                    target.write_bytes(&payload)?;
                    Ok((target.commit(), payload))
                })
            })
            .collect::<Vec<_>>();

        let mut paths = std::collections::HashSet::new();
        for worker in workers {
            let (path, payload) = worker
                .join()
                .map_err(|_| io::Error::new(io::ErrorKind::Other, "worker panicked"))??;
            assert!(
                paths.insert(path.clone()),
                "two downloads reserved one path"
            );
            assert_eq!(fs::read(path)?, payload);
        }

        fs::remove_dir_all(directory)
    }

    #[test]
    fn dropping_failed_download_removes_only_its_reservation() -> io::Result<()> {
        let directory = temporary_directory()?;
        let existing = directory.join("same-title.mp4");
        fs::write(&existing, b"existing user file")?;

        let mut target = DownloadTarget::reserve(&directory, "same-title", "mp4")?;
        assert_ne!(target.path(), existing);
        target.write_bytes(b"partial candidate")?;
        let reserved_path = target.path().to_path_buf();
        drop(target);

        assert_eq!(fs::read(existing)?, b"existing user file");
        assert!(!reserved_path.exists());
        fs::remove_dir_all(directory)
    }

    #[test]
    fn curl_can_write_to_reserved_download_path() -> io::Result<()> {
        if Command::new("curl").arg("--version").output().is_err() {
            return Ok(());
        }

        let directory = temporary_directory()?;
        let source = directory.join("curl-source.bin");
        let payload = b"curl fallback payload";
        fs::write(&source, payload)?;

        let target = DownloadTarget::reserve(&directory, "curl-result", "mp4")?;
        let source_url = format!("file:///{}", source.to_string_lossy().replace('\\', "/"));
        let output = Command::new("curl")
            .args(["--http1.1", "-L", "-s", "-o"])
            .arg(target.path())
            .arg(source_url)
            .output()?;
        assert!(
            output.status.success(),
            "curl could not write reserved output: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(target.has_bytes());
        assert_eq!(fs::read(target.path())?, payload);
        drop(target);
        fs::remove_dir_all(directory)
    }
}
