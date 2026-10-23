CREATE TRIGGER IF NOT EXISTS prevent_entity_tombstone_resurrection
BEFORE UPDATE OF deleted_at ON entities
FOR EACH ROW
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'entity_tombstoned');
END;
