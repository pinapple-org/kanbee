import { Class, Doc, MeasureMetricsContext, PersonId, Ref, Space, WorkspaceUuid } from '@hcengineering/core'
import type { FullTextAdapter, IndexedDoc, SearchStringResult } from '@hcengineering/server-core'

import { createMeiliAdapter } from '../adapter'

const MEILI_URL = process.env.MEILI_TEST_URL
const describeIfMeili = MEILI_URL !== undefined ? describe : describe.skip

async function waitForResult<T> (fn: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const start = Date.now()
  let last = await fn()
  while (!done(last) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    last = await fn()
  }
  return last
}

describeIfMeili('Meilisearch smoke', () => {
  let adapter: FullTextAdapter
  const ctx = new MeasureMetricsContext('meili-test', {})
  const workspace = `00000000-0000-4000-8000-${String(process.pid).padStart(12, '0')}` as WorkspaceUuid
  const issueClass = 'tracker:class:Issue' as Ref<Class<Doc>>
  const space = 'tracker:project:DefaultProject' as Ref<Space>

  beforeAll(async () => {
    adapter = await createMeiliAdapter(MEILI_URL ?? '')
    expect(await adapter.initMapping(ctx)).toBe(true)
  })

  afterAll(async () => {
    await adapter.clean(ctx, workspace)
    await adapter.close()
  })

  it('roundtrips a document id with underscores without leaking the workspace separator id', async () => {
    const doc: IndexedDoc = {
      id: 'doc_with_under_scores' as Ref<Doc>,
      _class: [issueClass],
      modifiedBy: 'kanbee-test' as PersonId,
      modifiedOn: Date.now(),
      space,
      searchTitle: 'Needle issue title',
      searchShortTitle: 'Needle',
      fulltextSummary: 'A Kanbee Meilisearch smoke-test document'
    }

    await adapter.index(ctx, workspace, doc)

    const rawSearch = await waitForResult<SearchStringResult>(
      async () =>
        await adapter.searchString(
          ctx,
          workspace,
          {
            query: 'Needle',
            classes: [issueClass],
            spaces: [space]
          },
          { limit: 10 }
        ),
      (result) => result.docs.some((hit) => hit.id === doc.id)
    )

    expect(rawSearch.docs.some((hit) => hit.id === doc.id)).toBe(true)
    expect(rawSearch.docs.every((hit) => hit.id !== `${doc.id}_${workspace}`)).toBe(true)

    const filtered = await waitForResult<IndexedDoc[]>(
      async () => await adapter.search(ctx, workspace, [issueClass], { space }, 10, 0),
      (hits) => hits.some((hit) => hit.id === doc.id)
    )

    expect(filtered.some((hit) => hit.id === doc.id)).toBe(true)
  }, 30_000)
})
