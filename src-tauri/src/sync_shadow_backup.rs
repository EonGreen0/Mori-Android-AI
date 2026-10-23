use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const BACKUP_DIRECTORY: &str = r"D:\开发\Mori-shadow-backups";
const BACKUP_SCHEMA: &str = "mori.shadow-sync-backup";
const BACKUP_VERSION: u8 = 1;
const STORAGE_KEY: &str = "mori_planner_board_v1";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShadowBackupDocument {
    schema: String,
    version: u8,
    created_at_unix_ms: u64,
    storage_key: String,
    board_schema_version: Option<serde_json::Value>,
    board_top_level_keys: Vec<String>,
    raw_bytes: u64,
    raw_text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowBackupReceipt {
    path: String,
    bytes: u64,
    verified: bool,
}

pub fn save(raw_text: &str) -> Result<ShadowBackupReceipt, String> {
    let board: serde_json::Value = serde_json::from_str(raw_text)
        .map_err(|_| "Planner Board text is not valid JSON")?;
    let board_object = board.as_object().ok_or("Planner Board must be an object")?;
    if !board_object.get("nodes").is_some_and(serde_json::Value::is_array)
        || !board_object.get("edges").is_some_and(serde_json::Value::is_array)
    {
        return Err("Planner Board must have nodes and edges arrays".into());
    }
    let board_schema_version = board_object
        .get("schemaVersion")
        .or_else(|| board_object.get("version"))
        .cloned();
    let board_top_level_keys = board_object.keys().cloned().collect::<Vec<_>>();
    let created_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock is before Unix epoch: {error}"))?
        .as_millis()
        .try_into()
        .map_err(|_| "System timestamp is out of range".to_string())?;
    let raw_bytes = u64::try_from(raw_text.len())
        .map_err(|_| "Raw Board text is too large".to_string())?;
    let document = ShadowBackupDocument {
        schema: BACKUP_SCHEMA.to_string(),
        version: BACKUP_VERSION,
        created_at_unix_ms,
        storage_key: STORAGE_KEY.to_string(),
        board_schema_version: board_schema_version.clone(),
        board_top_level_keys: board_top_level_keys.clone(),
        raw_bytes,
        raw_text: raw_text.to_string(),
    };
    let serialized = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("Could not serialize shadow backup: {error}"))?;

    let directory = Path::new(BACKUP_DIRECTORY);
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create shadow backup directory: {error}"))?;

    let mut suffix = 0u64;
    let (path, mut file) = loop {
        let candidate = directory.join(format!(
            "mori_planner_board_v1-{created_at_unix_ms}-{suffix}.json"
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => break (candidate, file),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                suffix = suffix
                    .checked_add(1)
                    .ok_or_else(|| "Could not allocate a unique shadow backup name".to_string())?;
            }
            Err(error) => {
                return Err(format!("Could not create shadow backup file: {error}"));
            }
        }
    };

    if let Err(error) = file.write_all(&serialized).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(format!("Could not write shadow backup file: {error}"));
    }
    drop(file);

    let written = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_file(&path);
            return Err(format!("Could not verify shadow backup file: {error}"));
        }
    };
    let verified = serde_json::from_slice::<ShadowBackupDocument>(&written)
        .map(|stored| {
            written == serialized
                && stored.schema == BACKUP_SCHEMA
                && stored.version == BACKUP_VERSION
                && stored.created_at_unix_ms == created_at_unix_ms
                && stored.storage_key == STORAGE_KEY
                && stored.board_schema_version == board_schema_version
                && stored.board_top_level_keys == board_top_level_keys
                && stored.raw_text == raw_text
                && stored.raw_bytes == raw_bytes
        })
        .unwrap_or(false);
    if !verified {
        let _ = fs::remove_file(&path);
        return Err("Shadow backup verification failed".to_string());
    }

    Ok(ShadowBackupReceipt {
        path: path.to_string_lossy().into_owned(),
        bytes: raw_bytes,
        verified: true,
    })
}
