// Persist input and completed local preparation steps; never auto-retry.
export function readCreationJournal(storage, key) {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    if (record.version !== 1 || typeof record.projectId !== 'string' || !record.input || typeof record.input !== 'object' || Array.isArray(record.input) || !record.completed || typeof record.completed !== 'object' || Array.isArray(record.completed)) throw new Error();
    return record;
  } catch {
    // Preserve the unreadable evidence before freeing the blocked key.
    storage.setItem(`${key}:damaged:${Date.now()}`, raw);
    storage.removeItem(key);
    throw new Error('恢复记录损坏，已保留副本。请先在项目列表核对已创建的项目，再重新开始。');
  }
}

export function creationJournal(storage, key, input, makeId) {
  const record = readCreationJournal(storage, key) ?? { version: 1, projectId: makeId(), input, completed: {} };
  if (JSON.stringify(record.input) !== JSON.stringify(input)) throw new Error('已有未完成的立项。请先恢复原来的内容，再从项目内提出修改，避免另建重复项目。');
  storage.setItem(key, JSON.stringify(record));
  return {
    record,
    async step(name, run) {
      if (Object.hasOwn(record.completed, name)) return record.completed[name];
      const value = await run(record);
      record.completed[name] = value ?? true;
      storage.setItem(key, JSON.stringify(record));
      return record.completed[name];
    },
    finish() { storage.removeItem(key); }
  };
}
