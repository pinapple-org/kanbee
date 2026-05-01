import { Analytics } from '@hcengineering/analytics'
import type {
  Class,
  Doc,
  DocumentQuery,
  MeasureContext,
  Ref,
  SearchOptions,
  SearchQuery,
  TxResult,
  WorkspaceUuid
} from '@hcengineering/core'
import type {
  FullTextAdapter,
  IndexedDoc,
  SearchScoring,
  SearchStringResult
} from '@hcengineering/server-core'
import serverCore from '@hcengineering/server-core'
import { getMetadata } from '@hcengineering/platform'
import { MeiliSearch, type Index } from 'meilisearch'

const DEFAULT_LIMIT = 200
const BATCH_SIZE = 500

const FILTERABLE_ATTRIBUTES = [
  'workspaceId',
  '_class',
  'attachedTo',
  'attachedToClass',
  'space',
  'modifiedBy',
  'modifiedOn',
  'id'
]

const SEARCHABLE_ATTRIBUTES = [
  'fulltextSummary',
  'searchTitle',
  'searchShortTitle'
]

function getIndexName (): string {
  return getMetadata(serverCore.metadata.ElasticIndexName) ?? 'storage_index'
}

function getIndexVersion (): string {
  return getMetadata(serverCore.metadata.ElasticIndexVersion) ?? 'v2'
}

function escapeFilterValue (value: unknown): string {
  if (value === null || value === undefined) return 'null'
  const s = String(value).replace(/'/g, "\\'")
  return `'${s}'`
}

function buildFilter (workspaceId: WorkspaceUuid, query?: DocumentQuery<Doc>): string[] {
  const filter: string[] = [`workspaceId = ${escapeFilterValue(workspaceId)}`]
  if (query === undefined) return filter
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('$')) continue
    if (value === null || value === undefined) continue
    if (typeof value === 'object' && value !== null && '$in' in value) {
      const list = (value as { $in: unknown[] }).$in
      if (list.length === 0) continue
      filter.push(`${key} IN [${list.map(escapeFilterValue).join(', ')}]`)
    } else {
      filter.push(`${key} = ${escapeFilterValue(value)}`)
    }
  }
  return filter
}

class MeiliAdapter implements FullTextAdapter {
  private readonly indexName: string
  private indexHandle: Index<Record<string, unknown>> | undefined
  private initialized = false
  private readonly getFulltextDocId: (w: WorkspaceUuid, d: Ref<Doc>) => string
  private readonly getDocId: (w: WorkspaceUuid, f: string) => Ref<Doc>

  constructor (
    private readonly client: MeiliSearch,
    indexBaseName: string,
    indexVersion: string
  ) {
    this.indexName = `${indexBaseName}_${indexVersion}`
    // Meili document ids only allow [a-zA-Z0-9_-] (max 511 bytes), so '@' is
    // rejected. Underscore is unambiguous to slice back since workspace UUIDs
    // contain hyphens. Reverse lives in `getDocId` below — keep them in sync.
    this.getFulltextDocId = (w, d) => `${d}_${w}`
    this.getDocId = (w, f) => f.slice(0, -1 * (w.length + 1)) as Ref<Doc>
  }

  private toIndexedDoc (workspaceId: WorkspaceUuid, hit: Record<string, unknown>): IndexedDoc {
    const fulltextId = typeof hit.id === 'string' ? hit.id : ''
    const storedDocId = typeof hit.docId === 'string' ? hit.docId : undefined
    const id = storedDocId ?? (fulltextId.length > 0 ? this.getDocId(workspaceId, fulltextId as Ref<Doc>) : hit.id)
    const { docId: _docId, ...rest } = hit
    return { ...(rest as unknown as IndexedDoc), id: id as Ref<Doc> }
  }

  private async getIndex (): Promise<Index<Record<string, unknown>>> {
    if (this.indexHandle !== undefined) return this.indexHandle
    try {
      await this.client.createIndex(this.indexName, { primaryKey: 'id' })
    } catch {
      // Already exists, ignore.
    }
    this.indexHandle = this.client.index<Record<string, unknown>>(this.indexName)
    return this.indexHandle
  }

  async initMapping (ctx: MeasureContext): Promise<boolean> {
    try {
      const index = await this.getIndex()
      if (!this.initialized) {
        await ctx.with('update-settings', {}, async () => {
          await index.updateFilterableAttributes(FILTERABLE_ATTRIBUTES)
          await index.updateSearchableAttributes(SEARCHABLE_ATTRIBUTES)
        })
        this.initialized = true
      }
      return true
    } catch (err: any) {
      ctx.warn('Meilisearch not available', { err })
      Analytics.handleError(err)
      return false
    }
  }

  async close (): Promise<void> {
    // meilisearch-js client has no close/dispose — nothing to release.
  }

  async searchString (
    ctx: MeasureContext,
    workspaceId: WorkspaceUuid,
    query: SearchQuery,
    options: SearchOptions & { scoring?: SearchScoring[] }
  ): Promise<SearchStringResult> {
    try {
      const index = await this.getIndex()
      const filter = buildFilter(workspaceId)
      if (query.classes !== undefined && query.classes.length > 0) {
        filter.push(`_class IN [${query.classes.map(escapeFilterValue).join(', ')}]`)
      }
      if (query.spaces !== undefined && query.spaces.length > 0) {
        filter.push(`space IN [${query.spaces.map(escapeFilterValue).join(', ')}]`)
      }
      const limit = options.limit ?? DEFAULT_LIMIT
      // Callers (e.g. presentation/src/search.ts) append `*` for ES prefix
      // matching. Meilisearch treats `*` as a literal character, so `john*`
      // matches nothing — strip the trailing wildcard. Meili already does
      // prefix-matching on the last token by default.
      const q = query.query.replace(/\*+$/, '')
      const result = await index.search<Record<string, unknown>>(q, {
        filter,
        limit,
        offset: 0,
        showRankingScore: true
      })
      const docs = result.hits.map((hit) => ({
        ...this.toIndexedDoc(workspaceId, hit),
        _score: (hit as { _rankingScore?: number })._rankingScore
      }))
      return { docs, total: result.estimatedTotalHits }
    } catch (err: any) {
      ctx.error('Meilisearch searchString error', { err })
      Analytics.handleError(err)
      return { docs: [] }
    }
  }

  async search (
    ctx: MeasureContext,
    workspaceId: WorkspaceUuid,
    _classes: Ref<Class<Doc>>[],
    search: DocumentQuery<Doc>,
    size?: number,
    from?: number
  ): Promise<IndexedDoc[]> {
    try {
      const index = await this.getIndex()
      const filter = buildFilter(workspaceId, search)
      if (_classes.length > 0) {
        filter.push(`_class IN [${_classes.map(escapeFilterValue).join(', ')}]`)
      }
      const limit = size ?? DEFAULT_LIMIT
      const offset = from ?? 0
      const result = await index.search<Record<string, unknown>>('', {
        filter,
        limit,
        offset
      })
      return result.hits.map((hit) => this.toIndexedDoc(workspaceId, hit))
    } catch (err: any) {
      ctx.error('Meilisearch search error', { err })
      Analytics.handleError(err)
      return []
    }
  }

  async index (ctx: MeasureContext, workspaceId: WorkspaceUuid, doc: IndexedDoc): Promise<TxResult> {
    const mIndex = await this.getIndex()
    const fulltextId = this.getFulltextDocId(workspaceId, doc.id)
    await mIndex.addDocuments([{ ...doc, id: fulltextId, docId: doc.id, workspaceId }])
    return {}
  }

  async update (
    ctx: MeasureContext,
    workspaceId: WorkspaceUuid,
    id: Ref<Doc>,
    update: Record<string, any>
  ): Promise<TxResult> {
    const mIndex = await this.getIndex()
    const fulltextId = this.getFulltextDocId(workspaceId, id)
    await mIndex.updateDocuments([{ id: fulltextId, ...update }])
    return {}
  }

  async updateMany (ctx: MeasureContext, workspaceId: WorkspaceUuid, docs: IndexedDoc[]): Promise<TxResult[]> {
    if (docs.length === 0) return []
    const mIndex = await this.getIndex()
    const batches: IndexedDoc[][] = []
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      batches.push(docs.slice(i, i + BATCH_SIZE))
    }
    for (const batch of batches) {
      const payload = batch.map((doc) => ({
        ...doc,
        id: this.getFulltextDocId(workspaceId, doc.id),
        docId: doc.id,
        workspaceId
      }))
      try {
        await mIndex.addDocuments(payload)
      } catch (err: any) {
        ctx.error('Meilisearch bulk index failed', { err, size: payload.length })
      }
    }
    return []
  }

  async load (ctx: MeasureContext, workspaceId: WorkspaceUuid, docs: Ref<Doc>[]): Promise<IndexedDoc[]> {
    if (docs.length === 0) return []
    const index = await this.getIndex()
    const ids = docs.map((id) => this.getFulltextDocId(workspaceId, id))
    const result = await index.search<Record<string, unknown>>('', {
      filter: [`id IN [${ids.map(escapeFilterValue).join(', ')}]`, `workspaceId = ${escapeFilterValue(workspaceId)}`],
      limit: docs.length,
      offset: 0
    })
    return result.hits.map((hit) => this.toIndexedDoc(workspaceId, hit))
  }

  async updateByQuery (
    ctx: MeasureContext,
    workspaceId: WorkspaceUuid,
    query: DocumentQuery<Doc>,
    update: Record<string, any>
  ): Promise<TxResult[]> {
    // Meilisearch has no server-side scripted update. Fetch matching docs,
    // apply the update client-side, push back. For high-cardinality updates
    // the caller should prefer direct `update` on known ids.
    const matches = await this.search(ctx, workspaceId, [], query, 10_000, 0)
    if (matches.length === 0) return []
    const mIndex = await this.getIndex()
    const payload = matches.map((doc) => ({
      ...doc,
      ...update,
      id: this.getFulltextDocId(workspaceId, doc.id),
      docId: doc.id,
      workspaceId
    }))
    await mIndex.updateDocuments(payload)
    return []
  }

  async remove (ctx: MeasureContext, workspaceId: WorkspaceUuid, docs: Ref<Doc>[]): Promise<void> {
    if (docs.length === 0) return
    const mIndex = await this.getIndex()
    const ids = docs.map((d) => this.getFulltextDocId(workspaceId, d))
    try {
      await mIndex.deleteDocuments(ids)
    } catch (err: any) {
      ctx.error('Meilisearch remove failed', { err })
    }
  }

  async removeByQuery (ctx: MeasureContext, workspaceId: WorkspaceUuid, query: DocumentQuery<Doc>): Promise<void> {
    const filter = buildFilter(workspaceId, query).join(' AND ')
    const mIndex = await this.getIndex()
    try {
      await mIndex.deleteDocuments({ filter })
    } catch (err: any) {
      ctx.error('Meilisearch removeByQuery failed', { err })
    }
  }

  async clean (ctx: MeasureContext, workspaceId: WorkspaceUuid): Promise<void> {
    const mIndex = await this.getIndex()
    try {
      await mIndex.deleteDocuments({ filter: `workspaceId = ${escapeFilterValue(workspaceId)}` })
    } catch (err: any) {
      ctx.error('Meilisearch clean failed', { err })
    }
  }
}

export interface MeiliConfig {
  host: string
  apiKey?: string
}

export function parseMeiliUrl (raw: string): MeiliConfig {
  // Accepts: meilisearch://[apikey@]host:port, meili://[apikey@]host:port, http(s)+meili://...
  const normalized = raw
    .replace(/^meilisearch\+?https:\/\//, 'https://')
    .replace(/^meilisearch\+?http:\/\//, 'http://')
    .replace(/^meilisearch:\/\//, 'http://')
    .replace(/^meili\+?https:\/\//, 'https://')
    .replace(/^meili\+?http:\/\//, 'http://')
    .replace(/^meili:\/\//, 'http://')
  const url = new URL(normalized)
  const apiKey = url.password !== '' ? decodeURIComponent(url.password) : (url.username !== '' ? decodeURIComponent(url.username) : undefined)
  url.username = ''
  url.password = ''
  return { host: url.toString().replace(/\/$/, ''), apiKey }
}

export function isMeiliUrl (raw: string): boolean {
  return raw.startsWith('meilisearch:') || raw.startsWith('meili:') || raw.startsWith('meilisearch+') || raw.startsWith('meili+')
}

export async function createMeiliAdapter (url: string): Promise<FullTextAdapter> {
  const config = parseMeiliUrl(url)
  const client = new MeiliSearch({ host: config.host, apiKey: config.apiKey })
  const indexBaseName = getIndexName()
  const indexVersion = getIndexVersion()
  // eslint-disable-next-line no-console
  console.info({ message: 'Using meili fulltext adapter', host: config.host, indexBaseName, indexVersion })
  return new MeiliAdapter(client, indexBaseName, indexVersion)
}
