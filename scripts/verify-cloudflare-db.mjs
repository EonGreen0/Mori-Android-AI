import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { applyMutationBatch, listProjects, pullChanges } from "../cloudflare/src/db.js";

// Execute production SQL against SQLite, rather than duplicating SQL semantics.
class SQLiteD1 {
  constructor({ includeProjectDirectoryArchive = true } = {}) {
    this.sqlite = new DatabaseSync(":memory:");
    for (const migration of ["0001_sync_core.sql", "0002_mutation_hash.sql", "0003_tombstone_guard.sql"]) {
      this.sqlite.exec(readFileSync(new URL("../cloudflare/migrations/" + migration, import.meta.url), "utf8"));
    }
    if (includeProjectDirectoryArchive) this.applyProjectDirectoryArchiveMigration();
  }
  applyProjectDirectoryArchiveMigration() {
    this.sqlite.exec(readFileSync(new URL("../cloudflare/migrations/0004_project_directory_archive.sql", import.meta.url), "utf8"));
  }
  prepare(sql) {
    const db = this.sqlite;
    const prepared = (args = []) => ({
      bind: (...values) => prepared(values),
      first: () => db.prepare(sql).get(...args) || null,
      all: () => ({ success: true, results: db.prepare(sql).all(...args) }),
      run: () => ({ success: true, meta: db.prepare(sql).run(...args) }),
    });
    return prepared();
  }
  async batch(statements) {
    if (this.beforeBatch) { const hook = this.beforeBatch; this.beforeBatch = null; await hook(); }
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map(statement => statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  entityKey(projectId, entityType, entityId) { return JSON.stringify([projectId, entityType, entityId]); }
  get projects() { return { get: id => this.sqlite.prepare("SELECT * FROM projects WHERE project_id = ?").get(id) }; }
  get entities() { return { get: key => this.sqlite.prepare("SELECT * FROM entities WHERE project_id = ? AND entity_type = ? AND entity_id = ?").get(...JSON.parse(key)) }; }
  get receipts() { return { get: id => this.sqlite.prepare("SELECT * FROM mutation_receipts WHERE op_id = ?").get(id) }; }
  get changes() { return this.sqlite.prepare("SELECT * FROM change_log ORDER BY revision").all(); }
}

const db = new SQLiteD1();
const projectId = "project_1";
const projectMutation = {
  opId: "op_project",
  projectId,
  entityType: "project",
  entityId: projectId,
  operation: "upsert",
  payload: { id: projectId, title: "Plan", payload: {} },
  baseRevision: 0,
  deviceId: "windows",
};
const nodeMutation = {
  opId: "op_node",
  projectId,
  entityType: "node",
  entityId: "node_a",
  operation: "upsert",
  payload: { id: "node_a", type: "text", text: "one" },
  baseRevision: 0,
  deviceId: "windows",
};

let result = await applyMutationBatch(db, projectId, [projectMutation, nodeMutation], { now: () => 100 });
assert.deepEqual(result.acknowledgedOpIds, ["op_project", "op_node"]);
assert.equal(db.projects.get(projectId).revision, 2);
assert.equal(db.changes.length, 2);

result = await applyMutationBatch(db, projectId, [nodeMutation], { now: () => 200 });
assert.deepEqual(result.acknowledgedOpIds, ["op_node"]);
assert.equal(db.projects.get(projectId).revision, 2, "idempotent retry incremented revision");
assert.equal(db.changes.length, 2, "idempotent retry duplicated change log");

const updated = {
  ...nodeMutation,
  opId: "op_node_update",
  payload: { ...nodeMutation.payload, text: "two" },
  baseRevision: 2,
};
result = await applyMutationBatch(db, projectId, [updated], { now: () => 300 });
assert.equal(db.projects.get(projectId).revision, 3);
assert.equal(db.entities.get(db.entityKey(projectId, "node", "node_a")).revision, 3);

const deletion = {
  ...nodeMutation,
  opId: "op_node_delete",
  operation: "delete",
  payload: null,
  baseRevision: 3,
};
result = await applyMutationBatch(db, projectId, [deletion], { now: () => 400 });
assert.equal(db.projects.get(projectId).revision, 4);
assert.equal(db.entities.get(db.entityKey(projectId, "node", "node_a")).deleted_at, 400);

const staleResurrection = {
  ...nodeMutation,
  opId: "op_node_stale",
  payload: { ...nodeMutation.payload, text: "stale resurrection" },
  baseRevision: 2,
};
result = await applyMutationBatch(db, projectId, [staleResurrection], { now: () => 500 });
assert.deepEqual(result.acknowledgedOpIds, ["op_node_stale"]);
assert.equal(db.receipts.get("op_node_stale").status, "superseded");
assert.equal(db.projects.get(projectId).revision, 4, "superseded mutation advanced revision");
assert.equal(db.changes.length, 4, "superseded mutation entered change log");

const repeatedDelete = { ...deletion, opId: "op_node_delete_again" };
await applyMutationBatch(db, projectId, [repeatedDelete], { now: () => 600 });
assert.equal(db.receipts.get("op_node_delete_again").status, "superseded");
assert.equal(db.projects.get(projectId).revision, 4);

const collision = { ...projectMutation, opId: "op_node", payload: { id: projectId, title: "collision", payload: {} } };
result = await applyMutationBatch(db, projectId, [collision], { now: () => 700 });
assert.equal(result.rejected[0].code, "op_id_conflict");
assert.equal(result.rejected[0].retryable, false);

const invalidAsset = {
  opId: "op_bad_asset",
  projectId,
  entityType: "asset",
  entityId: "sha256:not-valid",
  operation: "upsert",
  payload: { id: "sha256:not-valid", source: { hash: "sha256:not-valid" }, display: { hash: "nope" } },
};
result = await applyMutationBatch(db, projectId, [invalidAsset], { now: () => 800 });
assert.equal(result.rejected[0].code, "invalid_asset");

const page1 = await pullChanges(db, projectId, "0", 2);
assert.deepEqual(page1.changes.map((item) => item.revision), [1, 2]);
assert.equal(page1.cursor, "2");
assert.equal(page1.hasMore, true);
const page2 = await pullChanges(db, projectId, page1.cursor, 10);
assert.deepEqual(page2.changes.map((item) => item.revision), [3, 4]);
assert.equal(page2.cursor, "4");
assert.equal(page2.hasMore, false);

// A stale whole-payload write cannot undo another device's independent edit.
{
  const concurrent = new SQLiteD1();
  const seed = { ...nodeMutation, opId: "seed", payload: { ...nodeMutation.payload, x: 0 } };
  await applyMutationBatch(concurrent, projectId, [seed]);
  const phone = { ...seed, opId: "phone", baseRevision: 1, payload: { ...seed.payload, x: 50 } };
  await applyMutationBatch(concurrent, projectId, [phone]);
  const stale = { ...seed, opId: "desktop", baseRevision: 1, payload: { ...seed.payload, text: "desktop" } };
  const rejected = await applyMutationBatch(concurrent, projectId, [stale]);
  assert.equal(rejected.rejected[0].code, "revision_conflict");
  assert.equal(rejected.rejected[0].retryable, true);
  assert.equal(concurrent.projects.get(projectId).revision, 2);
  assert.equal(JSON.parse(concurrent.entities.get(concurrent.entityKey(projectId, "node", "node_a")).payload_json).x, 50);
  assert.equal(concurrent.receipts.get("desktop"), undefined);
  // A winner arriving after the initial entity read is still protected inside SQL.
  concurrent.beforeBatch = () => applyMutationBatch(concurrent, projectId, [{
    ...phone, opId: "raced_phone", baseRevision: 2, payload: { ...phone.payload, x: 75 },
  }]);
  const raced = await applyMutationBatch(concurrent, projectId, [{ ...stale, opId: "raced_desktop", baseRevision: 2 }]);
  assert.equal(raced.rejected[0].code, "revision_conflict");
  assert.equal(concurrent.projects.get(projectId).revision, 3);
  assert.equal(concurrent.changes.length, 3);
}
// Project metadata revision is independent of intervening node revisions.
{
  const metadata = new SQLiteD1();
  await applyMutationBatch(metadata, projectId, [projectMutation, nodeMutation]);
  const rename = { ...projectMutation, opId: "rename", baseRevision: 1,
    payload: { ...projectMutation.payload, title: "Renamed" } };
  assert.equal((await applyMutationBatch(metadata, projectId, [rename])).acknowledgedOpIds.length, 1);
  const staleRename = await applyMutationBatch(metadata, projectId, [{ ...rename, opId: "stale_rename", baseRevision: 1 }]);
  assert.equal(staleRename.rejected[0].code, "revision_conflict");
  assert.equal(metadata.projects.get(projectId).revision, 3);
}

// Directory archiving is independent of project contents, history, and sync by ID.
{
  const directoryDb = new SQLiteD1({ includeProjectDirectoryArchive: false });
  const fixtures = Array.from({ length: 73 }, (_, index) => ({
    projectId: index === 0 ? "keep_hinata" : index === 1 ? "keep_test" : `archive_fixture_${index}`,
    title: index === 0 ? "天野阳菜" : index === 1 ? "测试" : `项目 ${index}`,
  }));

  for (const [index, fixture] of fixtures.entries()) {
    const assetId = `sha256:${String(index + 1).padStart(64, "0")}`;
    const mutations = [
      {
        ...projectMutation,
        opId: `directory_project_${index}`,
        projectId: fixture.projectId,
        entityId: fixture.projectId,
        payload: { id: fixture.projectId, title: fixture.title },
        baseRevision: 0,
      },
      {
        ...nodeMutation,
        opId: `directory_node_${index}`,
        projectId: fixture.projectId,
        entityId: `node_${index}`,
        payload: { id: `node_${index}`, type: "text", text: `preserve ${index}` },
        baseRevision: 0,
      },
      {
        ...nodeMutation,
        opId: `directory_asset_${index}`,
        projectId: fixture.projectId,
        entityType: "asset",
        entityId: assetId,
        payload: { id: assetId, source: { hash: assetId }, display: { hash: assetId } },
        baseRevision: 0,
      },
    ];
    const seeded = await applyMutationBatch(directoryDb, fixture.projectId, mutations, { now: () => index + 1000 });
    assert.equal(seeded.acknowledgedOpIds.length, 3);
  }

  // Apply the schema change after rows already exist, as on an upgraded D1 database.
  directoryDb.applyProjectDirectoryArchiveMigration();
  assert.equal(directoryDb.sqlite.prepare("SELECT COUNT(*) AS count FROM projects WHERE archived_at IS NULL").get().count, 73);
  assert.equal((await listProjects(directoryDb, 200)).projects.length, 73);

  const archivedFixtures = fixtures.slice(2);
  const archivedProjectIds = archivedFixtures.map((fixture) => fixture.projectId);
  const targetId = archivedProjectIds[0];
  const targetBeforeArchive = {
    project: directoryDb.sqlite.prepare("SELECT revision FROM projects WHERE project_id = ?").get(targetId),
    changes: directoryDb.sqlite.prepare("SELECT COUNT(*) AS count FROM change_log WHERE project_id = ?").get(targetId).count,
    entities: directoryDb.sqlite.prepare("SELECT COUNT(*) AS count FROM entities WHERE project_id = ?").get(targetId).count,
  };
  const archivePlaceholders = archivedProjectIds.map(() => "?").join(",");
  directoryDb.sqlite.prepare(`UPDATE projects SET archived_at = ? WHERE project_id IN (${archivePlaceholders})`)
    .run(5000, ...archivedProjectIds);

  const visibleAfterArchive = await listProjects(directoryDb, 200);
  assert.deepEqual(new Set(visibleAfterArchive.projects.map((project) => project.projectId)), new Set(["keep_hinata", "keep_test"]));
  assert.equal(directoryDb.sqlite.prepare("SELECT revision FROM projects WHERE project_id = ?").get(targetId).revision, targetBeforeArchive.project.revision);
  assert.equal(directoryDb.sqlite.prepare("SELECT COUNT(*) AS count FROM change_log WHERE project_id = ?").get(targetId).count, targetBeforeArchive.changes);
  assert.equal(directoryDb.sqlite.prepare("SELECT COUNT(*) AS count FROM entities WHERE project_id = ?").get(targetId).count, targetBeforeArchive.entities);

  const archivedChanges = await pullChanges(directoryDb, targetId, "0", 20);
  assert.deepEqual(archivedChanges.changes.map((change) => change.entityType), ["project", "node", "asset"]);
  const targetNodeId = `node_${fixtures.findIndex((fixture) => fixture.projectId === targetId)}`;
  assert.equal(archivedChanges.changes[1].payload.text, "preserve 2");
  const archivedNode = { ...nodeMutation, opId: "archived_project_node_update", projectId: targetId,
    entityId: targetNodeId, baseRevision: 2,
    payload: { id: targetNodeId, type: "text", text: "still writable by ID" } };
  const archivedMutation = await applyMutationBatch(directoryDb, targetId, [archivedNode], { now: () => 6000 });
  assert.deepEqual(archivedMutation.acknowledgedOpIds, ["archived_project_node_update"]);
  assert.ok(!(await listProjects(directoryDb, 200)).projects.some((project) => project.projectId === targetId));

  const newProjectId = "added_after_archive_migration";
  const newProject = { ...projectMutation, opId: "new_project_after_archive_migration",
    projectId: newProjectId, entityId: newProjectId, payload: { id: newProjectId, title: "新策划" }, baseRevision: 0 };
  await applyMutationBatch(directoryDb, newProjectId, [newProject], { now: () => 7000 });
  assert.ok((await listProjects(directoryDb, 200)).projects.some((project) => project.projectId === newProjectId));

  const beforeRestore = {
    revision: directoryDb.sqlite.prepare("SELECT revision FROM projects WHERE project_id = ?").get(targetId).revision,
    changes: directoryDb.sqlite.prepare("SELECT COUNT(*) AS count FROM change_log WHERE project_id = ?").get(targetId).count,
    entities: directoryDb.sqlite.prepare("SELECT COUNT(*) AS count FROM entities WHERE project_id = ?").get(targetId).count,
  };
  directoryDb.sqlite.prepare("UPDATE projects SET archived_at = NULL WHERE project_id = ?").run(targetId);
  assert.ok((await listProjects(directoryDb, 200)).projects.some((project) => project.projectId === targetId));
  assert.equal(directoryDb.sqlite.prepare("SELECT revision FROM projects WHERE project_id = ?").get(targetId).revision, beforeRestore.revision);
  assert.equal(directoryDb.sqlite.prepare("SELECT COUNT(*) AS count FROM change_log WHERE project_id = ?").get(targetId).count, beforeRestore.changes);
  assert.equal(directoryDb.sqlite.prepare("SELECT COUNT(*) AS count FROM entities WHERE project_id = ?").get(targetId).count, beforeRestore.entities);
}
console.log("cloudflare SQLite transaction/idempotency/concurrent-write/project-archive verification passed");
