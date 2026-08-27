export class StoreSessionConversationSource {
  constructor({ store, pageSize = 500 } = {}) {
    if (!store?.listCanonicalVisibleConversationItems) throw new Error('canonical visible conversation store is required');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('pageSize is invalid');
    this.store = store;
    this.pageSize = pageSize;
  }

  async listAll(roleId) {
    const items = [];
    const cursors = new Set();
    let cursor = null;
    do {
      const page = this.store.listCanonicalVisibleConversationItems(roleId, {
        cursor,
        limit: this.pageSize
      });
      if (!page || !Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) {
        throw new Error('canonical visible conversation page is invalid');
      }
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (cursors.has(cursor)) throw new Error('canonical visible conversation cursor repeated');
        cursors.add(cursor);
      }
    } while (cursor !== null);
    return items;
  }
}
