import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchQQExploreAppendShelf, fetchQQExploreBootstrap, fetchQQExploreFeed, fetchQQExploreSimilarShelf } from './api'
import { getExploreCookie } from '../../services/exploreApi'
import { dedupeQQModules, qqModuleIdentity, type QQExploreCard, type QQExploreModule, type QQExploreSnapshot, type QQExploreState } from './model'

const CACHE_PREFIX = 'waveforge:qq-explore:v5:'
const FEED_STALE_MS = 10 * 60 * 1000
const LOAD_MORE_BATCHES = 5

function fingerprint(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function qqExploreAccountKey(userId?: string) {
  if (userId) return `user:${userId}`
  const cookie = getExploreCookie('qq')
  return cookie ? `cookie:${fingerprint(cookie)}` : 'guest'
}

function cacheKey(userId?: string) {
  return `${CACHE_PREFIX}${qqExploreAccountKey(userId)}`
}

function readCache(userId?: string): QQExploreSnapshot | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId))
    if (!raw) return null
    const value = JSON.parse(raw) as QQExploreSnapshot
    return value?.feed?.modules ? { ...value, musicHall: Array.isArray(value.musicHall) ? value.musicHall : [] } : null
  } catch {
    return null
  }
}

function writeCache(userId: string | undefined, snapshot: QQExploreSnapshot) {
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(snapshot))
  } catch {
    // In-memory state remains authoritative when the localStorage quota is full.
  }
}

export function useQQExploreController(loggedIn: boolean, userId?: string, authRevision = 0) {
  const [state, setState] = useState<QQExploreState>(() => ({
    snapshot: readCache(userId),
    initialLoading: true,
    refreshing: false,
    refreshingModuleId: '',
    moduleErrors: {},
    loadingMore: false,
    loadingMoreProgress: 0,
    error: '',
    paginationError: '',
  }))
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const contextualController = useRef<AbortController | null>(null)


  const loadInitial = useCallback(async (force = false) => {
    if (!loggedIn) {
      setState({ snapshot: null, initialLoading: false, refreshing: false, refreshingModuleId: '', moduleErrors: {}, loadingMore: false, loadingMoreProgress: 0, error: '', paginationError: '' })
      return
    }
    const cached = readCache(userId)
    // 快照还新鲜：直接用快照渲染，不再打一次 bootstrap。视图被隐藏/重挂载（切模式再回来、
    // StrictMode 双执行、authRevision 抖动）时这是最主要的重复请求来源；手动刷新走 refreshFeed。
    if (!force && cached && Date.now() - cached.generatedAt < FEED_STALE_MS) {
      generation.current += 1
      controller.current?.abort()
      contextualController.current?.abort()
      setState(previous => ({
        ...previous,
        snapshot: previous.snapshot || cached,
        initialLoading: false,
        refreshing: false,
        refreshingModuleId: '',
        moduleErrors: {},
        loadingMore: false,
        loadingMoreProgress: 0,
        error: '',
        paginationError: '',
      }))
      return
    }
    const id = ++generation.current
    controller.current?.abort()
    contextualController.current?.abort()
    const abortController = new AbortController()
    controller.current = abortController
    setState(previous => ({
      ...previous,
      snapshot: previous.snapshot || cached,
      initialLoading: !previous.snapshot && !cached,
      refreshing: force || Boolean((previous.snapshot || cached) && Date.now() - (previous.snapshot || cached)!.generatedAt > FEED_STALE_MS),
      refreshingModuleId: '',
      moduleErrors: {},
      loadingMore: false,
      loadingMoreProgress: 0,
      error: '',
      paginationError: '',
    }))
    try {
      const snapshot = await fetchQQExploreBootstrap(abortController.signal)
      if (id !== generation.current) return
      const existingDaily = (previous: QQExploreSnapshot | null) => {
        if (!previous?.daily30) return snapshot.daily30
        if (!snapshot.daily30) return previous.daily30
        return previous.daily30.dateKey === snapshot.daily30.dateKey ? previous.daily30 : snapshot.daily30
      }
      setState(previous => {
        const next = { ...snapshot, daily30: existingDaily(previous.snapshot) }
        writeCache(userId, next)
        return { ...previous, snapshot: next, initialLoading: false, refreshing: false, error: '' }
      })
    } catch (error) {
      if (id !== generation.current) return
      if (abortController.signal.aborted) {
        setState(previous => ({ ...previous, initialLoading: false, refreshing: false }))
        return
      }
      setState(previous => ({ ...previous, initialLoading: false, refreshing: false, error: error instanceof Error ? error.message : 'QQ 推荐加载失败' }))
    }
  }, [loggedIn, userId])

  useEffect(() => {
    setState(previous => ({ ...previous, snapshot: readCache(userId), paginationError: '' }))
    void loadInitial(false)
    return () => {
      generation.current += 1
      controller.current?.abort()
      contextualController.current?.abort()
    }
  }, [loadInitial, authRevision, userId])

  const refreshFeed = useCallback(async () => {
    const current = state.snapshot
    if (!current || state.initialLoading || state.refreshing || state.refreshingModuleId || state.loadingMore) return
    const id = ++generation.current
    controller.current?.abort()
    contextualController.current?.abort()
    const abortController = new AbortController()
    controller.current = abortController
    setState(previous => ({ ...previous, refreshing: true, loadingMore: false, loadingMoreProgress: 0, error: '', paginationError: '' }))
    try {
      const feed = await fetchQQExploreFeed(
        { page: 1, shelfCount: 0 },
        [],
        [],
        null,
        abortController.signal,
      )
      if (id !== generation.current) return
      setState(previous => {
        if (!previous.snapshot) return previous
        const next = {
          ...previous.snapshot,
          generatedAt: Date.now(),
          feed,
          // A feed refresh must never replace the account's already-resolved Daily 30.
          daily30: previous.snapshot.daily30,
        }
        writeCache(userId, next)
        return { ...previous, snapshot: next, refreshing: false, error: '' }
      })
    } catch (error) {
      if (abortController.signal.aborted || id !== generation.current) return
      setState(previous => ({ ...previous, refreshing: false, error: error instanceof Error ? error.message : '刷新推荐失败' }))
    }
  }, [state.initialLoading, state.loadingMore, state.refreshing, state.refreshingModuleId, state.snapshot, userId])

  const refreshModule = useCallback(async (module: QQExploreModule) => {
    if (!state.snapshot || !module.refresh || state.initialLoading || state.refreshing || state.loadingMore || state.refreshingModuleId) return
    const targetIdentity = qqModuleIdentity(module)
    const id = ++generation.current
    controller.current?.abort()
    contextualController.current?.abort()
    const abortController = new AbortController()
    controller.current = abortController
    setState(previous => ({ ...previous, refreshingModuleId: targetIdentity, moduleErrors: { ...previous.moduleErrors, [targetIdentity]: '' } }))
    try {
      const page = await fetchQQExploreFeed(
        { page: 1, shelfCount: 0 },
        state.snapshot.feed.modules.map(item => item.id),
        state.snapshot.feed.modules.flatMap(item => item.cards.map(card => card.feedKey)).filter(Boolean),
        module.refresh,
        abortController.signal,
      )
      if (id !== generation.current) return
      setState(previous => {
        if (!previous.snapshot) return previous
        const targetIdentity = qqModuleIdentity(module)
        const targetMatches = previous.snapshot.feed.modules.filter(item => qqModuleIdentity(item) === targetIdentity)
        const replacements = page.modules.filter(item => qqModuleIdentity(item) === targetIdentity)
        if (targetMatches.length !== 1) {
          return { ...previous, refreshingModuleId: '', moduleErrors: { ...previous.moduleErrors, [targetIdentity]: '栏目状态已变化，请刷新整个推荐页后重试' } }
        }
        if (replacements.length !== 1) {
          const message = replacements.length === 0 ? 'QQ 音乐未返回新的栏目内容，已保留当前推荐' : 'QQ 音乐返回了多个栏目版本，已保留当前推荐'
          return { ...previous, refreshingModuleId: '', moduleErrors: { ...previous.moduleErrors, [targetIdentity]: message } }
        }
        const modules = previous.snapshot.feed.modules.map(item => qqModuleIdentity(item) === targetIdentity ? replacements[0] : item)
        const next = { ...previous.snapshot, generatedAt: Date.now(), feed: { ...previous.snapshot.feed, modules } }
        writeCache(userId, next)
        return { ...previous, snapshot: next, refreshingModuleId: '', moduleErrors: { ...previous.moduleErrors, [targetIdentity]: '' } }
      })
    } catch (error) {
      if (abortController.signal.aborted || id !== generation.current) return
      setState(previous => ({ ...previous, refreshingModuleId: '', moduleErrors: { ...previous.moduleErrors, [targetIdentity]: error instanceof Error ? error.message : '栏目刷新失败' } }))
    }
  }, [state.initialLoading, state.loadingMore, state.refreshing, state.refreshingModuleId, state.snapshot, userId])

  const appendFromCard = useCallback(async (module: QQExploreModule, card: QQExploreCard, action: 'play' | 'like') => {
    if (!state.snapshot || !card.appendToken || state.initialLoading || state.refreshing || state.refreshingModuleId || state.loadingMore || contextualController.current) return
    const requestGeneration = ++generation.current
    const requestAccount = qqExploreAccountKey(userId)
    const moduleIdentity = qqModuleIdentity(module)
    const abortController = new AbortController()
    contextualController.current = abortController
    try {
      const result = await fetchQQExploreAppendShelf(card.appendToken, action, abortController.signal)
      if (requestGeneration !== generation.current || requestAccount !== qqExploreAccountKey(userId)) return
      setState(previous => {
        if (!previous.snapshot) return previous
        const modules = dedupeQQModules([...previous.snapshot.feed.modules, ...result.modules])
        const next = { ...previous.snapshot, generatedAt: Date.now(), feed: { ...previous.snapshot.feed, modules } }
        writeCache(userId, next)
        return { ...previous, snapshot: next, moduleErrors: { ...previous.moduleErrors, [moduleIdentity]: '' } }
      })
    } catch (error) {
      if (abortController.signal.aborted || requestGeneration !== generation.current || requestAccount !== qqExploreAccountKey(userId)) return
      setState(previous => ({ ...previous, moduleErrors: { ...previous.moduleErrors, [moduleIdentity]: error instanceof Error ? error.message : '追加推荐加载失败' } }))
    } finally {
      if (contextualController.current === abortController) contextualController.current = null
    }
  }, [state.initialLoading, state.loadingMore, state.refreshing, state.refreshingModuleId, state.snapshot, userId])

  const replaceWithSimilar = useCallback(async (module: QQExploreModule, card: QQExploreCard) => {
    if (!state.snapshot || !card.appendToken || state.refreshing || state.refreshingModuleId || state.loadingMore || contextualController.current) return
    const moduleIdentity = qqModuleIdentity(module)
    const requestGeneration = ++generation.current
    const requestAccount = qqExploreAccountKey(userId)
    const abortController = new AbortController()
    contextualController.current = abortController
    setState(previous => ({ ...previous, refreshingModuleId: moduleIdentity, moduleErrors: { ...previous.moduleErrors, [moduleIdentity]: '' } }))
    try {
      const result = await fetchQQExploreSimilarShelf(card.appendToken, abortController.signal)
      if (requestGeneration !== generation.current || requestAccount !== qqExploreAccountKey(userId)) return
      setState(previous => {
        if (!previous.snapshot) return previous
        const index = previous.snapshot.feed.modules.findIndex(item => qqModuleIdentity(item) === moduleIdentity)
        if (index < 0 || result.modules.length === 0) return { ...previous, refreshingModuleId: '', moduleErrors: { ...previous.moduleErrors, [moduleIdentity]: '未获取到相似栏目，已保留当前推荐' } }
        const modules = [...previous.snapshot.feed.modules]
        modules.splice(index, 1, ...result.modules)
        const next = { ...previous.snapshot, generatedAt: Date.now(), feed: { ...previous.snapshot.feed, modules: dedupeQQModules(modules) } }
        writeCache(userId, next)
        return { ...previous, snapshot: next, refreshingModuleId: '', moduleErrors: { ...previous.moduleErrors, [moduleIdentity]: '' } }
      })
    } catch (error) {
      if (abortController.signal.aborted || requestGeneration !== generation.current || requestAccount !== qqExploreAccountKey(userId)) return
      setState(previous => ({ ...previous, refreshingModuleId: '', moduleErrors: { ...previous.moduleErrors, [moduleIdentity]: error instanceof Error ? error.message : '相似推荐加载失败' } }))
    } finally {
      if (contextualController.current === abortController) contextualController.current = null
    }
  }, [state.loadingMore, state.refreshing, state.refreshingModuleId, state.snapshot, userId])

  const loadMore = useCallback(async () => {
    if (!state.snapshot?.feed.hasMore || state.initialLoading || state.refreshing || state.refreshingModuleId || state.loadingMore) return
    const snapshot = state.snapshot
    const id = ++generation.current
    controller.current?.abort()
    contextualController.current?.abort()
    const abortController = new AbortController()
    controller.current = abortController
    setState(previous => ({ ...previous, loadingMore: true, loadingMoreProgress: 0, paginationError: '' }))
    try {
      let mergedModules = snapshot.feed.modules
      let cursor = snapshot.feed.cursor
      let hasMore = snapshot.feed.hasMore
      let loadMark = snapshot.feed.loadMark
      let noGrowthCount = 0

      for (let batch = 0; batch < LOAD_MORE_BATCHES && hasMore; batch += 1) {
        const previousCardCount = mergedModules.reduce((total, module) => total + module.cards.length, 0)
        const page = await fetchQQExploreFeed(
          cursor,
          mergedModules.map(module => module.id),
          mergedModules.flatMap(module => module.cards.map(card => card.feedKey)).filter(Boolean),
          null,
          abortController.signal,
        )
        if (id !== generation.current) return
        mergedModules = dedupeQQModules([...mergedModules, ...page.modules])
        const nextCardCount = mergedModules.reduce((total, module) => total + module.cards.length, 0)
        noGrowthCount = nextCardCount === previousCardCount ? noGrowthCount + 1 : 0
        cursor = page.cursor
        loadMark = page.loadMark
        hasMore = page.hasMore && noGrowthCount < 2
        const partialSnapshot = {
          ...snapshot,
          generatedAt: Date.now(),
          feed: { modules: mergedModules, cursor, loadMark, hasMore },
        }
        writeCache(userId, partialSnapshot)
        setState(previous => id === generation.current ? {
          ...previous,
          snapshot: partialSnapshot,
          loadingMoreProgress: batch + 1,
        } : previous)
      }

      setState(previous => {
        if (!previous.snapshot || id !== generation.current) return previous
        const next = {
          ...previous.snapshot,
          feed: { modules: mergedModules, cursor, loadMark, hasMore },
        }
        writeCache(userId, next)
        return { ...previous, snapshot: next, loadingMore: false, loadingMoreProgress: 0, paginationError: '' }
      })
    } catch (error) {
      if (abortController.signal.aborted || id !== generation.current) return
      setState(previous => ({ ...previous, loadingMore: false, loadingMoreProgress: 0, paginationError: error instanceof Error ? error.message : '加载更多失败' }))
    }
  }, [state.initialLoading, state.loadingMore, state.refreshing, state.refreshingModuleId, state.snapshot, userId])

  return useMemo(() => ({ state, loadInitial, refreshFeed, refreshModule, appendFromCard, replaceWithSimilar, loadMore }), [appendFromCard, loadInitial, loadMore, refreshFeed, refreshModule, replaceWithSimilar, state])
}
