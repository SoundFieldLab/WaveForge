import { useState, useEffect, useRef, useCallback, useMemo, memo, type ReactElement } from 'react'
import { List, useDynamicRowHeight, type ListImperativeAPI, type RowComponentProps } from 'react-window'
import { motion, AnimatePresence } from 'framer-motion'
import { Song } from '../services/musicApi'
import { platformLabel, type MusicPlatform } from '../services/platforms'
import { createSodaComment, fetchSodaComments, isSodaLoggedIn, type SodaComment } from '../services/sodaService'
import {
  fetchKugouComments,
  fetchKugouCommentFloor,
  fetchKugouLatestComments,
  fetchKugouHotComments,
  fetchKugouHotWordComments,
  fetchKugouClassifyComments,
  sendKugouComment,
  replyKugouComment,
  likeKugouCommentItem,
  getKugouConceptCredential,
  hasKugouConceptCredential,
  type KugouComment,
  type KugouHotWord,
  type KugouCommentClassify,
} from '../services/kugouService'
import { ThumbsUp, MessageCircle, Trash2, Send, ChevronDown, X, Gauge, Image as ImageIcon, Copy, Smile, Loader2, Settings2 } from 'lucide-react'
import ScrollToTop from './ScrollToTop'
import DeleteCommentModal from './DeleteCommentModal'
import CachedImage from './CachedImage'
import CommentDanmaku from './CommentDanmaku'
import { getResolvedArtworkUrl } from '../services/artworkLoader'
import { debugLog, isVerboseLogEnabled } from '../utils/debugLog'
import { createTtlCache } from '../utils/ttlCache'
import { commentTimeValue, formatCommentTime } from '../utils/commentFormat'
import { getReadableAccentColor } from '../utils/desktopAccentColor'
import { useTvBack } from '../tv/tvCore'

// 评论分页短 TTL 缓存：按 `平台:资源ID:排序` 存已加载的评论 + 游标/页码。
// 反复开关同一首评论时直接回填，既不重发请求也不清空列表（避免「已加载的评论闪一下又重来」）。
// 只用内存、不落盘；空结果与错误不入缓存；登录态变化时清空。
interface CachedCommentPage {
  comments: Comment[]
  hot: Comment[]
  page: number
  hasMore: boolean
  cursor: string
}
const commentPageCache = createTtlCache<CachedCommentPage>({ ttlMs: 3 * 60 * 1000, maxEntries: 24 })
if (typeof window !== 'undefined') {
  window.addEventListener('waveforge-auth-changed', () => commentPageCache.clear())
}

interface PlaylistCommentResource {
  id: number | string
  name: string
  coverImgUrl?: string
  description?: string
  desc?: string
  creator?: { userId?: number | string; nickname?: string; avatarUrl?: string }
  tags?: string[]
  createTime?: number
  commentCount?: number
  platform?: MusicPlatform
}

interface CommentModalProps {
  isOpen: boolean
  onClose: () => void
  song?: Song | null
  playlist?: PlaylistCommentResource | null
  resourceType?: 'song' | 'playlist'
  /** 播放器深浅色：评论区跟随全局主题，深浅两套底色都由封面推导 */
  playerTheme?: 'light' | 'dark'
  /** 封面色：用于弹幕/标签/按钮的高亮色，缺失时回退品牌粉 */
  accentColor?: string
  /** 打开网易云歌单（评论用户主页弹窗里的歌单卡） */
  onOpenPlaylist?: (playlist: { id: string; name: string; coverUrl: string; platform: 'netease' }) => void
}

interface Reply {
  replyId: string
  content: string
  user: {
    nickname: string
    avatarUrl: string
    userId?: string
  }
  time: number | string
  beRepliedUser?: string
  /** 楼中楼归属的根评论：QQ 回复要带 rootCommentId + parentCommentId 才能形成二级回复 */
  rootId?: string
  /** QQ 回复里可能出现的图片标记（网页接口不返回原图，只做提示） */
  hasImage?: boolean
}

interface CommentTopic {
  id: number | string
  title: string
}

interface Comment {
  commentId: string
  content: string
  user: {
    nickname: string
    avatarUrl: string
    userId?: string
  }
  time: number | string
  likedCount: number
  replyCount: number
  replies?: Reply[]
  isLiked?: boolean
  isOwn?: boolean
  rootCommentId?: number | string
  /** 图片评论：网易云直接给图片地址；QQ 网页接口只在正文里留 [图片] 标记 */
  contentPicUrl?: string | null
  hasImage?: boolean
  /** 评论自带的话题标签（网易云 topicList） */
  topics?: CommentTopic[]
  /** 歌词引用（QQ music.globalComment：LyricLines） */
  lyricLines?: string[]
  /** IP 属地（QQ Location / 网易云 IP 字段） */
  ipLocation?: string
  /** 表情贴纸（网易云 expressionUrl / QQ EmoPic） */
  stickerUrl?: string
  /** VIP 图标（QQ VipIcon） */
  vipIcon?: string
  /** 精选热评（弹幕气泡高亮用） */
  hot?: boolean
  /** 酷狗楼层评论所需的 special_child_id（hot_replylist 的 childrenid） */
  kugouSpecialChildId?: string
}

/** 评论弹窗页签：总览=弹幕幕布；推荐（QQ 为精彩评论）/ 最热评论 / 最新评论为列表 */
type CommentTab = 'overview' | 'recommend' | 'hot' | 'latest'
/** 请求用的排序模式（决定 sortType / QQ cmd），与页签一一对应 */
type LoadMode = 'recommend' | 'hot' | 'latest'

/** 只带操作所需字段的评论引用：列表行、弹幕气泡、钉住面板都能直接传进来 */
type CommentRef = { commentId: string; user: { nickname: string } }
type LikeTarget = { commentId: string; isLiked?: boolean; likedCount: number }
/** 回复目标：回复评论（rootId 为空）或回复楼中楼里某条回复（rootId 为根评论） */
interface ReplyTarget {
  commentId: string
  username: string
  rootId?: string
}

function normalizeDescriptionText(value?: string): string {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;|&#0*160;?|&#x0*a0;?/gi, ' ')
    .replace(/&#(\d+);?/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);?/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * QQ 评论正文清洗：网页接口把表情写成 `[em]e400867[/em]`、图片写成 `[图片]`，
 * 表情码表只在客户端里（网页接口拿不到对应 Unicode），直接照抄会在界面上显示成乱码标记。
 * 这里剥掉表情标记、把 [图片] 记成 hasImage 供列表渲染成图片占位。
 */
function cleanQQCommentContent(raw: string): { content: string; hasImage: boolean } {
  const hasImage = /\[图片\]/.test(raw)
  const content = raw
    .replace(/\[em\]e?\d+\[\/em\]/gi, '')
    .replace(/\[图片\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return { content, hasImage }
}

function mapQQComments(rawComments: any[]): Comment[] {
  const commentMap = new Map<string, Comment>()

  rawComments.forEach((raw) => {
    const rootId = String(raw.rootcommentid || raw.commentid || raw.time || '')
    if (!rootId) return

    const isReplyEnvelope = Boolean(raw.commentid && raw.rootcommentid && raw.commentid !== raw.rootcommentid)
    const middleReplies = Array.isArray(raw.middlecommentcontent) ? raw.middlecommentcontent : []
    const mappedReplies: Reply[] = middleReplies.map((reply: any) => {
      const cleaned = cleanQQCommentContent(String(reply.subcommentcontent || ''))
      return {
        replyId: String(reply.subcommentid || raw.commentid || `${rootId}-${reply.replynick || ''}`),
        content: cleaned.content,
        hasImage: cleaned.hasImage || undefined,
        user: {
          nickname: String(reply.replynick || raw.nick || '匿名用户').replace(/^@/, ''),
          avatarUrl: isReplyEnvelope ? String(raw.avatarurl || '').replace(/^http:/, 'https:') : '',
          userId: reply.encrypt_replyuin || reply.replyuin || raw.encrypt_uin || ''
        },
        time: Number(raw.time || 0) * 1000,
        beRepliedUser: String(reply.replyednick || raw.rootcommentnick || '').replace(/^@/, '') || undefined,
        rootId,
      }
    })

    const existing = commentMap.get(rootId)
    if (existing) {
      const knownReplyIds = new Set(existing.replies?.map(reply => reply.replyId) || [])
      existing.replies = [
        ...(existing.replies || []),
        ...mappedReplies.filter(reply => !knownReplyIds.has(reply.replyId))
      ]
      existing.replyCount = existing.replies.length
      existing.time = Math.max(Number(existing.time), Number(raw.time || 0) * 1000)
      return
    }

    const rootContent = cleanQQCommentContent(String(raw.rootcommentcontent || ''))
    const topics: CommentTopic[] = raw.taoge_topic
      ? [{ id: String(raw.taoge_url || raw.taoge_topic), title: String(raw.taoge_topic) }]
      : []
    commentMap.set(rootId, {
      commentId: rootId,
      content: rootContent.content,
      hasImage: rootContent.hasImage || undefined,
      topics: topics.length ? topics : undefined,
      user: {
        nickname: String(isReplyEnvelope ? raw.rootcommentnick : raw.nick || '匿名用户').replace(/^@/, ''),
        // 回复包中的 avatarurl 属于回复者，不能错误地展示成主评论头像。
        avatarUrl: isReplyEnvelope ? '' : String(raw.avatarurl || '').replace(/^http:/, 'https:'),
        userId: isReplyEnvelope
          ? (raw.encrypt_rootcommentuin || raw.rootcommentuin || '')
          : (raw.encrypt_uin || raw.uin || '')
      },
      time: Number(raw.time || 0) * 1000,
      likedCount: Number(raw.praisenum || 0),
      replyCount: mappedReplies.length,
      replies: mappedReplies,
      isLiked: Number(raw.ispraise) === 1,
      isOwn: Number(raw.root_enable_delete ?? raw.enable_delete) === 1
    })
  })

  return Array.from(commentMap.values())
}

function isQQCommentMutationSuccessful(result: any): boolean {
  const message = String(
    result?.error || result?.message || result?.errMsg ||
    result?.data?.error || result?.data?.message || result?.data?.errMsg || ''
  )
  if (/失败|invalid|error|过期|失效/i.test(message)) return false
  if (/成功/.test(message)) return true
  return [result?.result, result?.code, result?.data?.result, result?.data?.code]
    .some(value => value === 0 || value === 100 || value === 200)
}

/** 汽水评论 → 组件内部展示结构（含楼中楼回复预览；点赞/回复仅静态展示） */
function mapSodaComments(rawComments: SodaComment[]): Comment[] {
  return rawComments
    .map(raw => {
      const replies = (Array.isArray(raw.replies) ? raw.replies : []).map(reply => ({
        replyId: String(reply.id || ''),
        content: String(reply.content || ''),
        user: {
          nickname: String(reply.user?.name || '匿名用户'),
          avatarUrl: String(reply.user?.avatarUrl || '')
        },
        time: reply.time
      }))
      return {
        commentId: String(raw.id || ''),
        content: String(raw.content || ''),
        user: {
          nickname: String(raw.user?.name || '匿名用户'),
          avatarUrl: String(raw.user?.avatarUrl || '')
        },
        time: raw.time,
        likedCount: Number(raw.likes || 0),
        replyCount: replies.length,
        replies
      }
    })
    .filter(item => item.commentId && item.content)
}

/** 酷狗评论（/mcomment/v1/cmtlist 族）→ 组件内部结构；addtime 是秒，统一换算成毫秒 */
function mapKugouComment(item: KugouComment, mixSongId: number, index: number): Comment {
  return {
    commentId: String(item.id || `kugou-${mixSongId}-${item.addtime}-${index}`),
    content: String(item.content || ''),
    user: {
      nickname: String(item.userName || '酷狗用户'),
      avatarUrl: String(item.userPic || ''),
      userId: item.userId,
    },
    time: (Number(item.addtime) || 0) * 1000,
    likedCount: Number(item.likeCount) || 0,
    replyCount: Number(item.replyCount) || 0,
    replies: [],
    isLiked: Boolean(item.hasLiked),
    isOwn: false,
    contentPicUrl: item.picUrl || null,
    ipLocation: item.location || undefined,
    kugouSpecialChildId: item.specialChildId || undefined,
  }
}

/** QQ 评论正文净化：[em]eXXXX[/em] 内联表情码当前无法渲染原图，剥掉标记保留文字 */
function stripQQEmotionMarks(text: string): string {
  return String(text || '')
    .replace(/\[em\]e\d+\[\/em\]/g, '')
    .trim()
}

/** QQ 新版评论（music.globalComment.CommentRead，Hippy CmtList 逆向）→ 组件内部结构 */
function mapQQCommentV2(raw: any): Comment {
  const subs = (Array.isArray(raw?.SubComments) && raw.SubComments.length ? raw.SubComments : (Array.isArray(raw?.RepliedComments) ? raw.RepliedComments : [])) || []
  const replies: Reply[] = subs.map((r: any) => ({
    replyId: String(r.CmId || ''),
    content: stripQQEmotionMarks(String(r.Content || '')),
    user: {
      nickname: String(r.Nick || '匿名用户'),
      avatarUrl: String(r.Avatar || ''),
      userId: r.EncryptUin ? String(r.EncryptUin) : undefined,
    },
    time: Number(r.PubTime || 0) * 1000,
    beRepliedUser: r.ParentComment?.Nick ? String(r.ParentComment.Nick) : (r.RepliedNick ? String(r.RepliedNick) : undefined),
    hasImage: r.Pic ? true : undefined,
  }))
  return {
    commentId: String(raw.CmId || ''),
    content: stripQQEmotionMarks(String(raw.Content || '')),
    contentPicUrl: raw.Pic ? String(raw.Pic) : null,
    stickerUrl: raw.EmoPic ? String(raw.EmoPic) : undefined,
    vipIcon: raw.VipIcon ? String(raw.VipIcon) : undefined,
    lyricLines: Array.isArray(raw.LyricLines) && raw.LyricLines.length ? raw.LyricLines.map((l: any) => String(l)) : undefined,
    topics: Array.isArray(raw.HashTagList)
      ? raw.HashTagList.filter((t: any) => t?.Name).map((t: any) => ({ id: String(t.ID ?? t.Name), title: String(t.Name) }))
      : undefined,
    ipLocation: raw.Location ? String(raw.Location) : undefined,
    user: {
      nickname: String(raw.Nick || '匿名用户'),
      avatarUrl: String(raw.Avatar || ''),
      userId: raw.EncryptUin ? String(raw.EncryptUin) : undefined,
    },
    time: Number(raw.PubTime || 0) * 1000,
    likedCount: Number(raw.PraiseNum || 0),
    replyCount: Number(raw.ReplyCnt || 0),
    replies,
    isLiked: Number(raw.IsPraised) === 1,
    isOwn: Number(raw.IsSelf) === 1,
  }
}

// ===== 评论列表虚拟化 =====
// 评论行高可变（内容行数、展开楼中楼回复），采用扁平行数组 +
// useDynamicRowHeight（ResizeObserver 实测行高），只在「最新评论」页签使用。
type CommentRow =
  | { kind: 'comment'; comment: Comment; index: number }
  | { kind: 'load-more' }
  | { kind: 'no-more' }

type CommentRowData = {
  rows: CommentRow[]
  expandedReplies: Set<string>
  isLoggedIn: boolean
  canInteract: boolean
  currentUserId: string
  isDark: boolean
  accent: string
  /** 精彩评论页签：前三条加排名徽章 */
  showRank: boolean
  /** 酷狗删除上游未生效 → 行内删除按钮置灰 */
  deleteDisabled: boolean
  onLike: (comment: Comment) => void
  onReply: (target: ReplyTarget) => void
  onDelete: (comment: Comment) => void
  onToggleReplies: (comment: Comment) => void
  onOpenUser?: (comment: Comment) => void
  /** 点评论缩略图看原图（弹窗内 lightbox；酷狗/QQ 都带图） */
  onPreviewImage: (url: string) => void
  isLoadingMore: boolean
  onLoadMore: () => void
}

const RANK_COLORS = ['#f5a524', '#b8c0cc', '#c98b5e']

// 挂载动画只作用于首屏 N 条评论，避免每条评论都重复创建 framer-motion 入场动画
const COMMENT_ANIMATE_LIMIT = 20

interface CommentItemProps {
  comment: Comment
  index: number
  rank: number
  showRank: boolean
  expanded: boolean
  isLoggedIn: boolean
  canInteract: boolean
  canDelete: boolean
  /** 酷狗删除实测未生效：按钮置灰并说明（不隐藏，如实呈现能力边界） */
  deleteDisabled?: boolean
  isDark: boolean
  accent: string
  onLike: (comment: Comment) => void
  onReply: (target: ReplyTarget) => void
  onDelete: (comment: Comment) => void
  onToggleReplies: (comment: Comment) => void
  onOpenUser?: (comment: Comment) => void
  /** 点评论缩略图看原图（弹窗内 lightbox；酷狗/QQ 都带图） */
  onPreviewImage: (url: string) => void
}

// 独立 memo 组件：点赞/删除/展开回复时只有目标评论的对象引用变化，
// 其余行的 comment prop 引用不变，可跳过重渲染（避免整表重建）。
const CommentItem = memo(function CommentItem({
  comment, index, rank, showRank, expanded, isLoggedIn, canInteract, canDelete, deleteDisabled,
  isDark, accent, onLike, onReply, onDelete, onToggleReplies, onOpenUser, onPreviewImage,
}: CommentItemProps) {
  const shouldAnimate = index < COMMENT_ANIMATE_LIMIT
  const visibleReplies = expanded ? comment.replies : comment.replies?.slice(0, 1)
  const secondaryText = isDark ? 'text-white/45' : 'text-black/40'
  const actionBase = isDark
    ? 'text-white/55 hover:bg-white/10 hover:text-white'
    : 'text-black/50 hover:bg-black/5 hover:text-black/80'

  return (
    <motion.div
      {...(shouldAnimate ? { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } } : {})}
      className={`px-6 py-4 transition-colors ${isDark ? 'hover:bg-white/4' : 'hover:bg-black/3'}`}
    >
      <div className="flex items-start gap-3">
        {showRank && (
          <div
            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold"
            style={{ background: `${RANK_COLORS[Math.min(rank - 1, 2)]}22`, color: RANK_COLORS[Math.min(rank - 1, 2)] }}
          >
            {rank}
          </div>
        )}
        {comment.user.avatarUrl ? (
          <button
            type="button"
            onClick={() => onOpenUser?.(comment)}
            title="查看用户主页"
            className="h-9 w-9 flex-shrink-0 rounded-full transition-opacity hover:opacity-80"
          >
            <CachedImage
              src={comment.user.avatarUrl}
              alt={comment.user.nickname}
              className="h-9 w-9 rounded-full object-cover"
              role="row"
              size={64}
              priority="visible"
              fallback={<div className={`h-9 w-9 rounded-full ${isDark ? 'bg-white/10' : 'bg-black/10'}`} />}
            />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onOpenUser?.(comment)}
            title="查看用户主页"
            className="h-9 w-9 flex-shrink-0 rounded-full opacity-70 transition-opacity hover:opacity-100"
            style={{ background: accent }}
          />
        )}

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenUser?.(comment)}
              title="查看用户主页"
              className="truncate text-[13px] font-semibold transition-opacity hover:opacity-75 hover:underline underline-offset-2"
              style={{ color: accent }}
            >
              {comment.user.nickname}
            </button>
            {comment.vipIcon && (
              <CachedImage src={comment.vipIcon} alt="VIP" className="h-4 w-auto max-w-16 shrink-0 object-contain" role="row" size={64} priority="visible" />
            )}
            {comment.isOwn && (
              <span className="shrink-0 rounded-full px-1.5 py-[1px] text-[10px]" style={{ background: `${accent}22`, color: accent }}>
                我
              </span>
            )}
            <span className={`shrink-0 text-[11px] ${secondaryText}`}>{formatCommentTime(comment.time)}</span>
            {comment.ipLocation && (
              <span className={`shrink-0 text-[11px] ${secondaryText}`}>IP·{comment.ipLocation}</span>
            )}
          </div>

          <p className={`whitespace-pre-wrap break-words text-[13.5px] leading-6 ${isDark ? 'text-white/88' : 'text-black/80'}`}>
            {comment.content}
          </p>

          {/* 表情贴纸（网易云 expressionUrl / QQ EmoPic） */}
          {comment.stickerUrl && (
            <CachedImage
              src={comment.stickerUrl}
              alt="表情"
              className="mt-2 h-16 w-16 object-contain"
              role="row"
              size={128}
              priority="visible"
            />
          )}

          {/* 歌词引用（QQ 客户端同款：LyricLines 渲染成引号块） */}
          {comment.lyricLines && comment.lyricLines.length > 0 && (
            <div className={`mt-2 rounded-lg border-l-2 py-1.5 pl-3 ${isDark ? 'border-white/20 bg-white/4' : 'border-black/12 bg-black/3'}`}>
              {comment.lyricLines.map((line, lineIndex) => (
                <p key={lineIndex} className={`text-[12.5px] leading-5 ${isDark ? 'text-white/62' : 'text-black/58'}`}>
                  {line}
                </p>
              ))}
            </div>
          )}

          {/* 图片评论：网易云直接给图，QQ 网页接口只留 [图片] 标记（做占位说明） */}
          {comment.contentPicUrl && (
            <div className="mt-2">
              {/* 桌面端缩略图：限制在 220×160 的方框内（contain，不裁切内容），点开看原图。
                  此前用 max-h-320 + 全宽包裹层，宽图会被拉到整行宽、单条评论撑满整屏。 */}
              <button
                type="button"
                onClick={() => onPreviewImage(comment.contentPicUrl!)}
                title="点击查看大图"
                className="block max-w-full cursor-zoom-in rounded-xl transition-opacity hover:opacity-90"
              >
                <CachedImage
                  src={comment.contentPicUrl}
                  alt="评论图片"
                  className={`h-[160px] w-[220px] max-w-full rounded-xl border ${isDark ? 'bg-white/5' : 'bg-black/4'}`}
                  role="row"
                  size={480}
                  priority="visible"
                  fit="contain"
                  fallback={
                    <div className={`flex h-[160px] w-[220px] flex-col items-center justify-center gap-1 rounded-xl text-[11px] ${isDark ? 'bg-white/6 text-white/40' : 'bg-black/4 text-black/40'}`}>
                      <ImageIcon className="h-4 w-4" />
                      图片加载失败
                    </div>
                  }
                />
              </button>
            </div>
          )}
          {!comment.contentPicUrl && comment.hasImage && (
            <span className={`mt-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${isDark ? 'border-white/12 bg-white/6 text-white/50' : 'border-black/8 bg-black/4 text-black/45'}`}>
              <ImageIcon className="h-3 w-3" />
              该评论包含图片（当前接口未提供原图）
            </span>
          )}

          {/* 话题标签（网易云 topicList）：按平台原生样式展示成 #话题# */}
          {comment.topics && comment.topics.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {comment.topics.map(topic => (
                <span
                  key={`${topic.id}-${topic.title}`}
                  className="rounded-full px-2 py-0.5 text-[11px]"
                  style={{ background: `${accent}14`, color: accent }}
                >
                  #{topic.title}#
                </span>
              ))}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="mt-2.5 flex items-center gap-1">
            <button
              type="button"
              onClick={() => (isLoggedIn && canInteract ? onLike(comment) : undefined)}
              disabled={!isLoggedIn || !canInteract}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors disabled:cursor-default ${comment.isLiked ? '' : actionBase}`}
              style={comment.isLiked ? { color: accent, background: `${accent}1f` } : undefined}
            >
              <ThumbsUp className={`h-3.5 w-3.5 ${comment.isLiked ? 'fill-current' : ''}`} />
              <span>{comment.likedCount > 0 ? comment.likedCount : '赞'}</span>
            </button>

            {isLoggedIn && canInteract && (
              <button
                type="button"
                onClick={() => onReply({ commentId: comment.commentId, username: comment.user.nickname })}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors ${actionBase}`}
              >
                <MessageCircle className="h-3.5 w-3.5" />
                <span>回复</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => { void navigator.clipboard?.writeText(comment.content).catch(() => {}) }}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors ${actionBase}`}
              title="复制评论内容"
            >
              <Copy className="h-3.5 w-3.5" />
              <span>复制</span>
            </button>

            {canDelete && isLoggedIn && canInteract && (
              <button
                type="button"
                onClick={() => { if (!deleteDisabled) onDelete(comment) }}
                disabled={deleteDisabled}
                title={deleteDisabled ? '酷狗评论删除上游未生效（接口受理但列表不移除）' : undefined}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors ${
                  isDark ? 'text-white/55 hover:bg-white/10 hover:text-red-300' : 'text-black/50 hover:bg-black/5 hover:text-red-500'
                } disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>删除</span>
              </button>
            )}
          </div>

          {/* 回复列表（QQ 新接口的 ReplyCnt 恒为 0，但有 SubComments 预览时同样要显示楼层） */}
          {(comment.replyCount > 0 || (comment.replies && comment.replies.length > 0)) && (
            <div className={`mt-3 rounded-xl px-3.5 py-2.5 ${isDark ? 'bg-white/6' : 'bg-black/4'}`}>
              {comment.replies && comment.replies.length > 0 && (
                <div className="space-y-1.5">
                  {visibleReplies?.map((reply) => (
                    <div key={reply.replyId} className="text-[13px] leading-6">
                      <span className="font-medium" style={{ color: accent }}>{reply.user.nickname}</span>
                      {reply.beRepliedUser && (
                        <>
                          <span className={`mx-1 ${secondaryText}`}>回复</span>
                          <span className="font-medium" style={{ color: accent }}>{reply.beRepliedUser}</span>
                        </>
                      )}
                      <span className={secondaryText}>：</span>
                      <span className={isDark ? 'text-white/80' : 'text-black/75'}>{reply.content}</span>
                      {/* 回复楼中楼里的某条回复：QQ 需要带根评论 ID 才能形成二级楼；网易云按根评论回复 */}
                      {isLoggedIn && canInteract && (
                        <button
                          type="button"
                          onClick={() => onReply({ commentId: reply.replyId, username: reply.user.nickname, rootId: comment.commentId })}
                          className={`ml-2 shrink-0 text-[11px] opacity-60 transition-opacity hover:opacity-100 ${isDark ? 'text-white/70' : 'text-black/55'}`}
                        >
                          回复
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 展开楼中楼回复：网易云有 replyCount 计数；QQ 靠点击后拉全量（GetReplyCommentList） */}
              {(comment.replyCount > 1 || (comment.replies && comment.replies.length > 0)) && (
                <button
                  type="button"
                  onClick={() => onToggleReplies(comment)}
                  className="mt-1.5 text-xs transition-opacity hover:opacity-80"
                  style={{ color: accent }}
                >
                  {expanded
                    ? '收起回复'
                    : comment.replyCount > 1
                      ? `查看${comment.replyCount}条回复`
                      : '查看全部回复'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
})

// 虚拟行：按 kind 渲染；评论行复用已 memo 的 CommentItem（点赞/删除/展开仅目标行重渲染）。
function CommentVirtualRow({ index, style, ...data }: RowComponentProps<CommentRowData>): ReactElement | null {
  const row = data.rows[index]
  if (!row) return null
  if (row.kind === 'comment') {
    const comment = row.comment
    return (
      <div style={style}>
        <CommentItem
          comment={comment}
          index={row.index}
          rank={row.index + 1}
          showRank={data.showRank && row.index < 3}
          expanded={data.expandedReplies.has(comment.commentId)}
          isLoggedIn={data.isLoggedIn}
          canInteract={data.canInteract}
          canDelete={Boolean(comment.isOwn || (data.currentUserId && comment.user.userId === data.currentUserId))}
          deleteDisabled={data.deleteDisabled}
          isDark={data.isDark}
          accent={data.accent}
          onLike={data.onLike}
          onReply={data.onReply}
          onDelete={data.onDelete}
          onToggleReplies={data.onToggleReplies}
          onOpenUser={data.onOpenUser}
          onPreviewImage={data.onPreviewImage}
        />
      </div>
    )
  }
  if (row.kind === 'load-more') {
    return (
      <div style={style} className="flex items-center justify-center py-6">
        <button
          type="button"
          onClick={data.onLoadMore}
          disabled={data.isLoadingMore}
          className={`flex items-center gap-2 rounded-full border px-6 py-2 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            data.isDark
              ? 'border-white/15 bg-white/8 text-white/85 hover:bg-white/14'
              : 'border-black/8 bg-white/70 text-black/70 hover:bg-white'
          }`}
        >
          {data.isLoadingMore ? (
            <>
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span>加载中…</span>
            </>
          ) : (
            <>
              <span>加载更多评论</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </>
          )}
        </button>
      </div>
    )
  }
  // no-more
  return (
    <div style={style} className={`flex items-center justify-center py-6 text-xs ${data.isDark ? 'text-white/35' : 'text-black/35'}`}>
      没有更多评论了
    </div>
  )
}

const DANMAKU_SPEEDS = [0.5, 1, 1.5, 2] as const
/** 弹幕外观设置（字号/不透明度/昵称开关），localStorage 持久化 */
const DANMAKU_STYLE_STORAGE_KEY = 'waveforge:danmaku-style:v1'
interface DanmakuStyleSettings { fontScale: number; opacity: number; showNickname: boolean }
const DANMAKU_FONT_SCALES = [0.85, 1, 1.15] as const
const DANMAKU_OPACITIES = [0.65, 0.85, 1] as const
function readDanmakuStyle(): DanmakuStyleSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(DANMAKU_STYLE_STORAGE_KEY) || '')
    if (parsed && typeof parsed === 'object') {
      return {
        fontScale: DANMAKU_FONT_SCALES.includes(parsed.fontScale) ? parsed.fontScale : 1,
        opacity: DANMAKU_OPACITIES.includes(parsed.opacity) ? parsed.opacity : 1,
        showNickname: parsed.showNickname !== false,
      }
    }
  } catch { /* 读取失败用默认值 */ }
  return { fontScale: 1, opacity: 1, showNickname: true }
}
const DANMAKU_SPEED_STORAGE_KEY = 'commentDanmakuSpeed'
/** 弹幕池上限：所有列表页签加载到的评论（含楼中楼外的主楼）都会进池循环投放 */
const DANMAKU_POOL_CAP = 200
/** 发表框快捷表情：两平台正文都是纯文本，unicode emoji 双端通用 */
const COMPOSER_EMOJIS = ['😂', '❤️', '😭', '😍', '🥹', '😅', '🤔', '👍', '🔥', '🎵', '🎶', '✨', '🙌', '👀', '🫶', '🌙']

// memo：弹窗打开期间 App 高频重渲染不再整弹窗跟着调和；回调 prop 在调用侧已稳定化。
export default memo(function CommentModal({
  isOpen,
  onClose,
  song = null,
  playlist = null,
  resourceType = 'song',
  playerTheme = 'dark',
  accentColor = '#ec4899',
  onOpenPlaylist: onOpenPlaylistProp,
}: CommentModalProps) {
  // TV 遥控：BACK 应关闭本弹窗。此前没有任何返回处理，未消费的 BACK 会落到原生的
  // handleBackDefault → 第一次按 BACK 就把应用退掉（非播放页场景）。
  useTvBack(() => {
    if (!isOpen) return false
    onClose()
    return true
  }, [isOpen, onClose])
  const isDark = playerTheme === 'dark'
  const accent = useMemo(() => getReadableAccentColor(accentColor, '#ec4899'), [accentColor])
  const isPlaylistResource = resourceType === 'playlist'
  const resourcePlatform = isPlaylistResource ? (playlist?.platform || 'netease') : (song?.platform || 'netease')
  // QQ 评论接口的 topid 使用数字 songid，不是歌曲 MID。
  // 汽水的 Song.id 是截断数值，真实曲目 id 保存在 mid —— 评论资源 id 对汽水改用 mid。
  // 酷狗评论接口只认 mixsongid（album_audio_id），拿不到时退回 hash 由服务层给出明确错误。
  const resourceId = isPlaylistResource
    ? playlist?.id
    : (resourcePlatform === 'soda'
      ? String(song?.mid || song?.id || '')
      : resourcePlatform === 'kugou'
        ? String(song?.kugouMixSongId || song?.mid || song?.id || '')
        : song?.id)
  const commentType = isPlaylistResource ? 2 : 0
  const qqCommentBizType = isPlaylistResource ? 3 : 1
  const resourceCoverUrl = isPlaylistResource ? (playlist?.coverImgUrl || '') : (song?.album?.picUrl || '')
  const resourceBackgroundUrl = resourceCoverUrl
    ? getResolvedArtworkUrl(resourceCoverUrl, { role: 'background' })
    : ''
  const resourceName = isPlaylistResource ? (playlist?.name || '歌单详情') : (song?.name || '')
  const resourceSubtitle = isPlaylistResource
    ? (playlist?.creator?.nickname || (resourcePlatform === 'qq' ? 'QQ音乐歌单' : '网易云歌单'))
    : (song?.artists?.map((artist: any) => artist.name).join('、') || '')
  const resourceAlbumName = isPlaylistResource ? '' : (song?.album?.name || '')
  const playlistDescription = normalizeDescriptionText(playlist?.description || playlist?.desc) || '当前歌单暂无简介'
  const [allComments, setAllComments] = useState<Comment[]>([])
  const [hotComments, setHotComments] = useState<Comment[]>([])
  const [totalComments, setTotalComments] = useState(0)
  const [tab, setTab] = useState<CommentTab>('overview')
  const [danmakuSpeed, setDanmakuSpeed] = useState<number>(() => {
    if (typeof window === 'undefined') return 1
    const saved = Number(window.localStorage.getItem(DANMAKU_SPEED_STORAGE_KEY))
    return DANMAKU_SPEEDS.includes(saved as (typeof DANMAKU_SPEEDS)[number]) ? saved : 1
  })
  // 刚发表的评论：立刻作为「我」的弹幕上屏（等平台索引完成后由刷新流程取代）
  const [myPostedComments, setMyPostedComments] = useState<Comment[]>([])
  // 分享数（QQ ShareCnt）：评论区信息条用，展示这首歌被多少人传播过
  const [shareCount, setShareCount] = useState(0)
  // 发表框表情面板（PC 端快捷输入）
  const [showEmojiPanel, setShowEmojiPanel] = useState(false)

  // 自动加载更多 refs（在变量声明后同步）
  const hasMoreCommentsRef = useRef(false)
  const isLoadingMoreRef = useRef(false)
  const loadingRef = useRef(false)
  const loadCommentsRef = useRef<(reset?: boolean) => Promise<void>>(async () => {})
  // 竞态防护：热/最新切换或快速换资源时递增序号，晚到的旧请求落地前校验、过期直接丢弃
  const commentsRequestSeqRef = useRef(0)
  // 上次已加载的资源键（平台:资源ID:排序）：用于区分「换资源要清空」与「同资源重校验保留旧列表」
  const lastLoadedResourceRef = useRef('')
  // rAF 合并滚动续页检查：滚动事件高频触发，这里只在下一帧执行一次判定
  const scrollCheckFrameRef = useRef<number | null>(null)
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    if (!hasMoreCommentsRef.current || isLoadingMoreRef.current || loadingRef.current) return
    if (scrollCheckFrameRef.current !== null) return
    scrollCheckFrameRef.current = window.requestAnimationFrame(() => {
      scrollCheckFrameRef.current = null
      const container = scrollContainerRef.current
      if (!container) return
      if (!hasMoreCommentsRef.current || isLoadingMoreRef.current || loadingRef.current) return
      if (container.scrollHeight - container.scrollTop - container.clientHeight < 200) {
        loadCommentsRef.current(false)
      }
    })
  }, [])

  // 卸载时取消尚未执行的滚动续页 rAF 帧
  useEffect(() => () => {
    if (scrollCheckFrameRef.current !== null) {
      cancelAnimationFrame(scrollCheckFrameRef.current)
      scrollCheckFrameRef.current = null
    }
  }, [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [commentRefreshKey, setCommentRefreshKey] = useState(0)
  const [pendingDeleteComment, setPendingDeleteComment] = useState<Comment | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  /** 评论图片预览（点缩略图看原图；酷狗/QQ 的带图评论共用） */
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [newComment, setNewComment] = useState('')
  const [replyingTo, setReplyingTo] = useState<ReplyTarget | null>(null)
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // 分页相关状态
  const [currentPage, setCurrentPage] = useState(0)
  const [hasMoreComments, setHasMoreComments] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [cursor, setCursor] = useState<string>('-1') // 网易云时间排序首屏使用 -1，后续使用服务端 cursor
  // 汽水评论游标：soda 接口为游标分页（与上方页码分页不同），组件内部自行维护
  const sodaCursorRef = useRef<string | undefined>(undefined)

  // 酷狗评论上下文：歌曲级 specialId（点赞/最热榜必传，cmtlist 的 childrenid）+ 热词 chips + 选中热词。
  // cmtlist/getCommentWithLike 都会带回 childrenid，任何一次列表加载都能续上，不额外发探测请求。
  const kugouSpecialIdRef = useRef('')
  const [kugouHotWords, setKugouHotWords] = useState<KugouHotWord[]>([])
  const [kugouActiveWord, setKugouActiveWord] = useState('')
  // 分类标签（客户端第一排「歌曲相关 / 有图 / …」，来自 cmtlist 的 classify_list）与选中项；
  // 点选后走 cmt_classify_list（与热词筛选互斥）
  const [kugouClassify, setKugouClassify] = useState<KugouCommentClassify[]>([])
  const [kugouActiveClassify, setKugouActiveClassify] = useState('')

  // 获取登录状态和cookie
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [userCookie, setUserCookie] = useState('')
  const [currentUserId, setCurrentUserId] = useState<string>('')

  // 检查登录状态并获取用户ID
  useEffect(() => {
    const getUserInfo = async () => {
      if (resourcePlatform === 'netease') {
        const neteaseCookie = localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
        setUserCookie(neteaseCookie)
        setIsLoggedIn(!!neteaseCookie)

        // 获取当前用户ID
        if (neteaseCookie) {
          try {
            const res = await fetch(`http://localhost:3001/api/netease/user/account?cookie=${encodeURIComponent(neteaseCookie)}`)
            const data = await res.json()
            if (data.profile?.userId) {
              setCurrentUserId(data.profile.userId.toString())
            }
          } catch (error) {
            console.error('获取用户信息失败:', error)
          }
        }
      } else if (resourcePlatform === 'qq') {
        const qqCookie = localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
        setUserCookie(qqCookie)
        setIsLoggedIn(!!qqCookie)

        // QQ音乐获取用户ID
        if (qqCookie) {
          try {
            const res = await fetch('http://localhost:3001/api/qq/user/setCookie', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ data: qqCookie })
            })
            const data = await res.json()
            if (data.result === 100 && data.data?.uin) {
              setCurrentUserId(data.data.uin)
            }
          } catch (error) {
            console.error('获取QQ用户信息失败:', error)
          }
        }
      } else if (resourcePlatform === 'soda') {
        // 汽水：登录态按本地 cookie 特征粗判；评论列表未登录也可浏览
        setUserCookie('')
        setIsLoggedIn(isSodaLoggedIn())
        setCurrentUserId('')
      } else if (resourcePlatform === 'kugou') {
        // 酷狗：发表/点赞/回复走概念版扫码凭据；评论列表游客设备也可读
        setUserCookie('')
        setIsLoggedIn(hasKugouConceptCredential())
        setCurrentUserId(getKugouConceptCredential()?.userid || '')
      }
    }

    getUserInfo()
  }, [resourcePlatform])

  useEffect(() => {
    if (!currentUserId) return
    const markOwn = (comment: Comment) => ({ ...comment, isOwn: comment.user.userId === currentUserId })
    setAllComments(previous => previous.map(markOwn))
    setHotComments(previous => previous.map(markOwn))
    setMyPostedComments(previous => previous.map(markOwn))
  }, [currentUserId])

  // 汽水评论接口暂不提供点赞/回复/删除能力：行内操作退化为静态展示（酷狗已实测全通，见 kugouService）
  const rowsStatic = resourcePlatform === 'soda'
  const canInteract = !rowsStatic
  // 酷狗歌单评论上游未提供（仅单曲评论）：发表框锁定并注明原因
  const kugouComposerLocked = resourcePlatform === 'kugou' && isPlaylistResource
  const composerLocked = !isLoggedIn || kugouComposerLocked
  const composerPlaceholder = kugouComposerLocked
    ? '酷狗歌单评论暂未提供（仅支持单曲评论）'
    : composerLocked
      ? (resourcePlatform === 'soda' ? '登录汽水音乐后参与评论' : resourcePlatform === 'kugou' ? '扫码登录酷狗后参与评论' : '登录后参与评论')
      : (isPlaylistResource ? '发表歌单评价…' : '说点什么…')

  // 评论变更（发表/删除/刷新）后清缓存：只对「重新打开」做秒回，不把用户主动刷新也短路。
  const commentRefreshKeyRef = useRef(0)

  // 关闭时重置一次性 UI 状态：组件被 App 冻结（不卸载），否则删除确认框/展开的回复会跨次重开残留。
  useEffect(() => {
    if (isOpen) return
    setPendingDeleteComment(null)
    setReplyingTo(null)
    setExpandedReplies(new Set())
  }, [isOpen])

  // 每次打开（或换资源）都从「总览」进场：弹幕幕布是这个弹窗的主界面。
  // 酷狗例外：客户端只有 推荐/最热/最新 三个大类、没有总览，进场直接落在「推荐」。
  // 只依赖 isOpen/resourceId，不依赖 tab 派生出的 loadMode，避免自我触发加载循环。
  useEffect(() => {
    if (!isOpen) return
    setTab(resourcePlatform === 'kugou' ? 'recommend' : 'overview')
    // 换歌后自己刚发的那几条弹幕不再属于当前资源
    setMyPostedComments([])
    setShareCount(0)
    setShowEmojiPanel(false)
    // 酷狗上下文跟随资源：specialId/热词/分类是歌曲级数据，换歌必须清掉
    kugouSpecialIdRef.current = ''
    setKugouHotWords([])
    setKugouActiveWord('')
    setKugouClassify([])
    setKugouActiveClassify('')
  }, [isOpen, resourceId])

  // 页签 → 请求排序模式的映射：
  // - 网易云「推荐」用独立的推荐排序（sortType 99）；「最热」是热度排序（2）
  // - QQ 没有独立的推荐排序（逆向结论：cmd=8 最新附带精选热评、cmd=6/9 热度排序），
  //   「推荐」直接展示精选热评集合，与「最热」共用同一个请求（cmd=6），不重复发请求
  // - 酷狗三种排序实测走不同端点：推荐=cmtlist（混合序）、最热=H5 topliked（点赞量降序）、
  //   最新=web getCommentWithLike（最新优先+官方置顶热评）；「总览」进场按「最热」加载
  const loadMode: LoadMode = tab === 'latest'
    ? 'latest'
    : tab === 'recommend' && (resourcePlatform === 'netease' || resourcePlatform === 'kugou')
      ? 'recommend'
      : 'hot'

  useEffect(() => {
    if (isOpen && resourceId) {
      // 页签/资源/排序变化即失效所有在途请求：缓存命中分支不发新请求也不 bump seq，
      // 若不在此处递增，旧页签的晚到响应会被误判为「新鲜」覆盖缓存回填的视图
      commentsRequestSeqRef.current += 1
      // 酷狗热词筛选也参与缓存键（同一首歌不同热词的结果集互不覆盖）
      const cacheKey = `${resourcePlatform}:${resourceId}:${loadMode}${resourcePlatform === 'kugou' ? (kugouActiveWord ? `:w:${kugouActiveWord}` : kugouActiveClassify ? `:c:${kugouActiveClassify}` : '') : ''}`
      if (commentRefreshKey !== commentRefreshKeyRef.current) {
        commentRefreshKeyRef.current = commentRefreshKey
        commentPageCache.clear()
      }
      // 每次打开都收起回复态（与旧的「打开即重置」一致；命中缓存也不能跳过）
      setNewComment('')
      setReplyingTo(null)
      // 命中缓存：回填已加载的评论/页码/游标，不发请求、不清空（不闪白）。
      const cached = commentPageCache.get(cacheKey)
      if (cached && cached.comments.length) {
        lastLoadedResourceRef.current = cacheKey
        setAllComments(cached.comments)
        setHotComments(cached.hot)
        setCurrentPage(cached.page)
        setHasMoreComments(cached.hasMore)
        setCursor(cached.cursor)
        setLoading(false)
        setIsLoadingMore(false)
        setError(null)
        return
      }
      setCurrentPage(0)
      setHasMoreComments(true)
      setCursor('-1') // 重置cursor
      sodaCursorRef.current = undefined // 重置汽水评论游标
      loadComments(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, resourceId, loadMode, userCookie, commentRefreshKey, kugouActiveWord, kugouActiveClassify])

  // 同步加载更多 refs
  useEffect(() => {
    hasMoreCommentsRef.current = hasMoreComments
    isLoadingMoreRef.current = isLoadingMore
    loadingRef.current = loading
    loadCommentsRef.current = loadComments
  })

  const loadComments = async (reset = false) => {
    if (!resourceId) return
    const requestSeq = ++commentsRequestSeqRef.current
    // 本次请求是否仍是最新一次：快速切换排序/资源时旧响应晚到会覆盖新视图
    const isStaleRequest = () => requestSeq !== commentsRequestSeqRef.current
    // Apple 无公开评论接口：不请求平台评论
    if (resourcePlatform === 'apple') {
      setLoading(false)
      setIsLoadingMore(false)
      setError(null)
      return
    }

    if (reset) {
      setLoading(true)
      // 只在「换资源/换排序」时清空；同一资源重校验（登录态刷新、主动刷新）保留旧列表，避免闪白。
      const resourceKey = `${resourcePlatform}:${resourceId}:${loadMode}${resourcePlatform === 'kugou' ? (kugouActiveWord ? `:w:${kugouActiveWord}` : kugouActiveClassify ? `:c:${kugouActiveClassify}` : '') : ''}`
      if (lastLoadedResourceRef.current !== resourceKey) {
        lastLoadedResourceRef.current = resourceKey
        setAllComments([])
        setHotComments([])
      }
      setCurrentPage(0)
    } else {
      setIsLoadingMore(true)
    }

    setError(null)

    const cacheKey = `${resourcePlatform}:${resourceId}:${loadMode}${resourcePlatform === 'kugou' ? (kugouActiveWord ? `:w:${kugouActiveWord}` : kugouActiveClassify ? `:c:${kugouActiveClassify}` : '') : ''}`
    // 本次加载产出的热评/游标/hasMore，供成功后写回缓存（用局部变量，避免读到过期 state）
    let nextHot: Comment[] | null = null
    let nextCursor: string | null = null
    let hasMoreAfter: boolean | null = null

    try {
      const platform = resourcePlatform
      const songId = resourceId
      const pageToLoad = reset ? 0 : currentPage + 1
      const limit = 20
      const offset = pageToLoad * limit

      // ── 汽水音乐：游标分页，数据经 sodaService 获取（不走下方页码分页请求）──
      // 仅歌曲资源生效：汽水无歌单评论接口，歌单资源不进入此分支
      if (!isPlaylistResource && platform === 'soda') {
        const requestCursor = reset ? undefined : sodaCursorRef.current
        const page = await fetchSodaComments(String(songId), requestCursor, limit)
        if (isStaleRequest()) return
        // 记录下一页游标（先于状态写入保存，避免并发续页时被覆盖）
        sodaCursorRef.current = page.cursor ?? undefined
        const sodaComments = mapSodaComments(page.comments)
        // 汽水无独立热评接口，清空防止上一资源残留
        nextHot = []
        setHotComments([])
        if (sodaComments.length === 0 && reset) {
          setAllComments([])
          setHasMoreComments(false)
          return
        }
        if (reset) {
          setAllComments(sodaComments)
          window.requestAnimationFrame(() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
        } else {
          setAllComments(prev => {
            const merged = new Map(prev.map(comment => [comment.commentId, comment]))
            sodaComments.forEach(comment => merged.set(comment.commentId, comment))
            return Array.from(merged.values())
          })
        }
        // 「加载更多」按钮显隐由 hasMore 控制
        hasMoreAfter = page.hasMore
        setHasMoreComments(page.hasMore)
        setCurrentPage(pageToLoad)
        // 写回缓存：以「已加载的全部评论」为快照，重开直接回填
        {
          const existing = commentPageCache.get(cacheKey)
          const base = reset || !existing ? (reset ? sodaComments : []) : existing.comments
          const merged = new Map(base.map(comment => [comment.commentId, comment]))
          if (!reset) sodaComments.forEach(comment => merged.set(comment.commentId, comment))
          const snapshot = Array.from(merged.values())
          if (snapshot.length) commentPageCache.set(cacheKey, { comments: snapshot, hot: [], page: pageToLoad, hasMore: page.hasMore, cursor: '-1' })
        }
        return
      }

      // ── 酷狗：全功能评论（发表/点赞/回复/删除见 handle* 分支；三种排序实测端点不同）──
      // 推荐 = /mcomment/v1/cmtlist（默认混合序）；最热 = H5 /r/v1/rank/topliked（点赞量降序）；
      // 最新 = web commentsv2/getCommentWithLike（最新优先+官方置顶热评）。cmtlist 的 sort/order
      // 参数实测全部无效，无法用单端点出三种排序；热词筛选走 /mcomment/v1/get_hot_word。
      if (platform === 'kugou') {
        if (isPlaylistResource) {
          setAllComments([])
          setHotComments([])
          setHasMoreComments(false)
          setError('酷狗歌单评论上游未提供（仅支持单曲评论）')
          return
        }
        const mixSongId = Number(songId)
        if (!Number.isFinite(mixSongId) || mixSongId <= 0) {
          setAllComments([])
          setHotComments([])
          setHasMoreComments(false)
          setError('该曲目缺少酷狗 mixsongid，评论暂不可用（请从酷狗曲库重新打开该曲）')
          return
        }

        // 任何一次列表加载都会带回歌曲级 childrenid + 热词，这里统一续上下文
        const rememberContext = (childrenId: string, hotWords?: KugouHotWord[], classify?: KugouCommentClassify[]) => {
          if (childrenId) kugouSpecialIdRef.current = childrenId
          if (hotWords && hotWords.length) setKugouHotWords(hotWords)
          if (classify && classify.length) setKugouClassify(classify)
        }
        const myUserId = getKugouConceptCredential()?.userid || ''
        const mapRows = (rows: KugouComment[]) => rows.map((item, index) => {
          const mapped = mapKugouComment(item, mixSongId, index)
          return myUserId && mapped.user.userId === myUserId ? { ...mapped, isOwn: true } : mapped
        })
        // 三种排序/热词筛选共用的落库逻辑（合并去重 + 缓存回写）
        const applyPage = (mapped: Comment[], total: number, hasMore: boolean, hot: Comment[] | null = null) => {
          if (total > 0) setTotalComments(total)
          nextHot = hot
          setHotComments(hot ?? [])
          hasMoreAfter = hasMore
          setHasMoreComments(hasMore)
          if (reset) {
            setAllComments(mapped)
            window.requestAnimationFrame(() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
          } else {
            setAllComments(prev => {
              const merged = new Map(prev.map(comment => [comment.commentId, comment]))
              mapped.forEach(comment => merged.set(comment.commentId, comment))
              return Array.from(merged.values())
            })
          }
          setCurrentPage(pageToLoad)
          if (mapped.length) {
            const existing = commentPageCache.get(cacheKey)
            const base = reset || !existing ? (reset ? mapped : []) : existing.comments
            const merged = new Map(base.map(comment => [comment.commentId, comment]))
            if (!reset) mapped.forEach(comment => merged.set(comment.commentId, comment))
            commentPageCache.set(cacheKey, { comments: Array.from(merged.values()), hot: hot ?? [], page: pageToLoad, hasMore, cursor: '-1' })
          }
        }

        // 热词筛选：结果集小（热词出现次数），直接整页替换、不缓存（重查代价低）
        if (kugouActiveWord) {
          const wordPage = await fetchKugouHotWordComments(mixSongId, kugouActiveWord, pageToLoad + 1, limit)
          if (isStaleRequest()) return
          if (wordPage.error) throw new Error(wordPage.error)
          applyPage(mapRows(wordPage.comments), wordPage.total, wordPage.comments.length >= limit)
          return
        }

        // 分类筛选（客户端第一排标签「歌曲相关 / 有图 / …」）：type_id 走 cmt_classify_list，
        // 与热词筛选互斥；结果集是被筛过的子集，直接整页替换、不写缓存（重查代价低）
        if (kugouActiveClassify) {
          const classifyPage = await fetchKugouClassifyComments(mixSongId, kugouActiveClassify, pageToLoad + 1, limit)
          if (isStaleRequest()) return
          if (classifyPage.error) throw new Error(classifyPage.error)
          applyPage(mapRows(classifyPage.comments), classifyPage.total, classifyPage.comments.length >= limit)
          return
        }

        if (loadMode === 'latest') {
          const latest = await fetchKugouLatestComments(mixSongId, pageToLoad + 1, limit)
          if (isStaleRequest()) return
          if (latest.error) throw new Error(latest.error)
          rememberContext(latest.childrenId)
          // 分类标签行是客户端弹窗的常驻 UI：latest 端点不带 classify_list，
          // 还没拿到时用一页 cmtlist 探一次（与最热分支同款，代价 1 个 page=1&pagesize=1 请求）
          if (!kugouClassify.length) {
            const probe = await fetchKugouComments(mixSongId, 1, 1)
            if (isStaleRequest()) return
            rememberContext(probe.childrenId, probe.hotWords, probe.classify)
          }
          applyPage(mapRows(latest.comments), latest.total, latest.comments.length >= limit)
          return
        }

        if (loadMode === 'hot') {
          // 最热榜要歌曲级 specialId：列表上下文还没建立时先按推荐序探一页（顺带拿热词/分类 chips）
          let specialId = kugouSpecialIdRef.current
          if (!specialId || !kugouClassify.length) {
            const probe = await fetchKugouComments(mixSongId, 1, 1)
            if (isStaleRequest()) return
            rememberContext(probe.childrenId, probe.hotWords, probe.classify)
            specialId = specialId || probe.childrenId
          }
          if (!specialId) {
            // 无 specialId（实测=无评论曲目）：展示空态而不是报错
            applyPage([], 0, false)
            return
          }
          const hot = await fetchKugouHotComments(mixSongId, specialId, pageToLoad + 1, limit)
          if (isStaleRequest()) return
          if (hot.error) throw new Error(hot.error)
          applyPage(mapRows(hot.comments), hot.total, hot.comments.length >= limit)
          return
        }

        // 推荐序（默认）：cmtlist，也是热词/分类 chips 的来源
        const pageData = await fetchKugouComments(mixSongId, pageToLoad + 1, limit)
        if (isStaleRequest()) return
        if (pageData.error) throw new Error(pageData.error)
        rememberContext(pageData.childrenId, pageData.hotWords, pageData.classify)
        const hasMore = pageData.maxPage > 0 ? pageToLoad + 1 < pageData.maxPage : pageData.comments.length >= limit
        applyPage(mapRows(pageData.comments), pageData.total, hasMore)
        return
      }

      // 网易云音乐: sortType 99=推荐排序, 2=热度排序, 3=时间排序
      const sortType = loadMode === 'recommend' ? 99 : loadMode === 'hot' ? 2 : 3

      // ── QQ 新版评论（逆向 music.globalComment.CommentRead）：带图片/歌词引用/话题/IP 属地 ──
      // 精选（推荐页签 + 总览进场）与最新评论走新接口；最热评论仍走 h5 cmd=6 全量热度排序
      let comments: Comment[] = []
      if (platform === 'qq' && (loadMode === 'hot' || loadMode === 'latest')) {
        const method = loadMode === 'hot' ? 'GetHotCommentList' : 'GetNewCommentList'
        let qqCursor: { id?: string; seq?: string } = {}
        if (loadMode === 'latest' && !reset && cursor && cursor !== '-1') {
          try { qqCursor = JSON.parse(cursor) } catch { qqCursor = {} }
        }
        const musicuResponse = await fetch('http://localhost:3001/api/qq/comment/musicu', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            module: 'music.globalComment.CommentRead',
            method,
            param: {
              BizType: Number(qqCommentBizType),
              BizId: String(songId),
              LastCommentId: qqCursor.id || '',
              LastCommentSeqNo: qqCursor.seq || '',
              PageSize: limit,
              PageNum: reset ? 0 : pageToLoad,
              FromParentCmId: '', FromCommentId: '',
              WithHot: 1, HotType: 6, PicEnable: 1, SelfSeeEnable: 1,
              LastRspVer: '', CmListUIVer: 2, AudioEnable: 0,
            },
            cookie: userCookie,
          }),
        })
        if (!musicuResponse.ok) throw new Error(`HTTP ${musicuResponse.status}`)
        const musicuData = await musicuResponse.json()
        // 晚到的旧请求直接丢弃
        if (isStaleRequest()) return
        const resultData = musicuData?.req
        if (resultData?.code !== 0 || !resultData.data) {
          throw new Error(`QQ 新版评论接口错误 ${resultData?.code ?? '未知'}`)
        }
        const commentListV2 = resultData.data.CommentList || {}
        const rawCommentsV2 = commentListV2.Comments || []
        const totalV2 = Number(commentListV2.Total || 0)
        if (totalV2 > 0) setTotalComments(totalV2)
        const shareCnt = Number(resultData.data.ShareCnt || 0)
        if (shareCnt > 0) setShareCount(shareCnt)
        // 过滤空记录：空 CmId/空正文会渲染空行，且多条空 id 在 dedupe Map 与 React key 上碰撞
        comments = rawCommentsV2.map(mapQQCommentV2).filter((c: Comment) => c.commentId && c.content)
        if (loadMode === 'latest') {
          const lastRaw = rawCommentsV2[rawCommentsV2.length - 1]
          if (lastRaw?.CmId) {
            nextCursor = JSON.stringify({ id: String(lastRaw.CmId), seq: String(lastRaw.SeqNo || '') })
            setCursor(nextCursor)
          } else if (comments.length > 0) {
            // 服务端返回了评论但末条无 CmId：游标无法推进，下一页会拉到同一批数据。
            // 直接判定无更多，避免「加载更多」无限空转
            setHasMoreComments(false)
          }
        } else if (reset) {
          // 精选热评首屏：同步进 hotComments（QQ 推荐页签与弹幕池共用）；翻页不冲掉
          nextHot = comments
          setHotComments(comments)
        }
        // 最热/最新都可续页：热评 HasMore、最新游标
        hasMoreAfter = Boolean(commentListV2.HasMore)
        setHasMoreComments(hasMoreAfter)

        if (comments.length === 0 && reset) {
          setHasMoreComments(false)
          setAllComments([])
          return
        }
        if (reset) {
          setAllComments(comments)
          window.requestAnimationFrame(() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
          if (comments.length) {
            commentPageCache.set(cacheKey, {
              comments,
              hot: nextHot ?? [],
              page: pageToLoad,
              hasMore: hasMoreAfter,
              cursor: nextCursor ?? '-1',
            })
          }
        } else {
          setAllComments(prev => {
            const merged = new Map(prev.map(c => [c.commentId, c]))
            comments.forEach(c => merged.set(c.commentId, c))
            const next = Array.from(merged.values())
            // 最新按时间倒序；最热保持接口的热度排序（新页天然排在已加载内容之后）
            return loadMode === 'latest'
              ? next.sort((a, b) => commentTimeValue(b.time) - commentTimeValue(a.time))
              : reset ? next : [...prev, ...comments.filter(c => !prev.some(p => p.commentId === c.commentId))]
          })
          const existing = commentPageCache.get(cacheKey)
          if (existing) {
            const merged = new Map(existing.comments.map(c => [c.commentId, c]))
            comments.forEach(c => merged.set(c.commentId, c))
            commentPageCache.set(cacheKey, {
              ...existing,
              comments: Array.from(merged.values()),
              page: pageToLoad,
              hasMore: hasMoreAfter !== null ? hasMoreAfter : existing.hasMore,
              cursor: nextCursor ?? existing.cursor,
            })
          }
        }
        setCurrentPage(pageToLoad)
        return
      }

      // 构建请求URL
      let endpoint = ''
      if (platform === 'netease') {
        // 最新评论使用cursor分页，精彩评论使用offset分页
        if (loadMode === 'latest') {
          const cursorToUse = reset ? '-1' : cursor
          endpoint = `http://localhost:3001/api/netease/comment/music?id=${encodeURIComponent(String(songId))}&limit=${limit}&offset=${offset}&sortType=${sortType}&cursor=${cursorToUse}&type=${commentType}&cookie=${encodeURIComponent(localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || '')}`
        } else {
          endpoint = `http://localhost:3001/api/netease/comment/music?id=${encodeURIComponent(String(songId))}&limit=${limit}&offset=${offset}&sortType=${sortType}&type=${commentType}&cookie=${encodeURIComponent(localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || '')}`
        }
      } else {
        // 兜底路径：QQ 页签已全部切到新版接口（上方 musicu 分支），此端点仅在异常回退时使用
        endpoint = `http://localhost:3001/api/qq/comment?id=${encodeURIComponent(String(songId))}&pagenum=${pageToLoad}&pagesize=${limit}&type=${loadMode === 'hot' ? 'hot' : 'latest'}&biztype=${qqCommentBizType}&cookie=${encodeURIComponent(userCookie)}`
      }

      debugLog(`[评论加载] 平台: ${platform}, 歌曲ID: ${songId}, 页码: ${pageToLoad}`)

      const response = await fetch(endpoint)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()
      // 晚到的旧请求直接丢弃（视图可能已切到另一种排序/另一个资源）
      if (isStaleRequest()) return

      if (platform === 'netease') {
        if (data.code === 200) {
          // 新版API返回的数据在 data.comments 中
          const sourceComments = data.data?.comments || []
          // 评论总数（仅部分接口返回）
          const total = Number(data.data?.total || 0)
          if (total > 0) setTotalComments(total)

          // 网易云热评（精彩评论）单独展示
          if (data.data?.hotComments && Array.isArray(data.data.hotComments)) {
            nextHot = data.data.hotComments.map((c: any) => ({
              commentId: c.commentId,
              content: c.content,
              user: {
                nickname: c.user?.nickname || '匿名用户',
                avatarUrl: c.user?.avatarUrl || '',
                userId: c.user?.userId?.toString()
              },
              time: c.time,
              likedCount: c.likedCount || 0,
              rootCommentId: c.beReplied?.[0]?.beRepliedCommentId,
              replyCount: 0,
              replies: []
            })).filter(Boolean)
            setHotComments(nextHot ?? [])
          }

          // 保存cursor用于下次加载（仅最新评论需要）
          if (loadMode === 'latest' && data.data?.cursor) {
            nextCursor = String(data.data.cursor)
            setCursor(nextCursor)
          }

          // 检查是否还有更多评论
          const hasMore = data.data?.hasMore || false
          if (!hasMore) {
            hasMoreAfter = false
            setHasMoreComments(false)
          }

          comments = sourceComments.map((c: any) => ({
            commentId: c.commentId,
            content: c.content,
            contentPicUrl: c.contentPicUrl || c.contentPicExt?.picUrl || null,
            stickerUrl: c.expressionUrl ? String(c.expressionUrl) : undefined,
            ipLocation: c.ipLocation?.location ? String(c.ipLocation.location) : undefined,
            topics: Array.isArray(c.topicList)
              ? c.topicList
                  .map((topic: any) => ({ id: topic?.actId ?? topic?.topicId ?? '', title: String(topic?.title || '') }))
                  .filter((topic: CommentTopic) => topic.title)
              : undefined,
            user: {
              nickname: c.user?.nickname || '匿名用户',
              avatarUrl: c.user?.avatarUrl || '',
              userId: c.user?.userId?.toString()
            },
            time: c.time,
            likedCount: c.likedCount || 0,
            replyCount: c.showFloorComment?.replyCount || 0,
            // 网易云API默认不返回回复内容，需要单独请求
            replies: [],
            isLiked: c.liked || false,
            isOwn: currentUserId && c.user?.userId ? c.user.userId.toString() === currentUserId : false
          }))

          // 对于有回复的评论，自动加载前2条回复作为预览
          const commentsWithReplies = comments.filter(c => c.replyCount > 0)
          if (commentsWithReplies.length > 0) {
            // 加载楼中楼预览：分批并发（每批 6 个），避免热评多的歌曲一次性打出几十个请求
            const floorOf = async (comment: any) => {
              try {
                const floorResponse = await fetch(
                  `http://localhost:3001/api/netease/comment/floor?id=${encodeURIComponent(String(songId))}&parentCommentId=${comment.commentId}&limit=2&type=${commentType}&cookie=${encodeURIComponent(localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || '')}`
                )
                if (floorResponse.ok) {
                  const floorData = await floorResponse.json()
                  if (floorData.code === 200 && floorData.data?.comments) {
                    return {
                      commentId: comment.commentId,
                      replies: floorData.data.comments.map((r: any) => ({
                        replyId: r.commentId,
                        content: r.content,
                        user: {
                          nickname: r.user?.nickname || '匿名用户',
                          avatarUrl: r.user?.avatarUrl || ''
                        },
                        time: r.time,
                        beRepliedUser: r.beReplied?.[0]?.user?.nickname
                      }))
                    }
                  }
                }
              } catch (error) {
                console.error(`[加载回复预览] 评论${comment.commentId}失败:`, error)
              }
              return null
            }
            const replyResults: any[] = []
            const BATCH = 6
            for (let start = 0; start < commentsWithReplies.length; start += BATCH) {
              const batch = commentsWithReplies.slice(start, start + BATCH)
              replyResults.push(...await Promise.all(batch.map(floorOf)))
            }

            // 更新评论的回复数据
            replyResults.forEach(result => {
              if (result) {
                const commentIndex = comments.findIndex(c => c.commentId === result.commentId)
                if (commentIndex !== -1) {
                  comments[commentIndex].replies = result.replies
                }
              }
            })
          }
        }
      } else {
        // QQ音乐
        // 整页评论 JSON（含 beReplied/user）可达数百 KB，pretty-print 只在详细日志开启时执行，
        // 否则每次加载评论都会在主线程同步序列化一遍。
        if (isVerboseLogEnabled()) console.log('[QQ音乐评论] 原始数据:', JSON.stringify(data, null, 2))

        if (data.result === 0 && data.data) {
          const rawComments = data.data.comments || []
          debugLog('[QQ音乐评论] 评论数组:', rawComments)

          const total = Number(data.data.total || 0)
          if (total > 0) setTotalComments(total)

          if (rawComments.length > 0) {
            // QQ 的 middlecommentcontent 是回复数组，并非独立的扁平评论项。
            comments = mapQQComments(rawComments)

            // 如果是最新评论，按时间降序排序
            if (loadMode === 'latest') {
              comments.sort((a, b) => commentTimeValue(b.time) - commentTimeValue(a.time))
            }

            debugLog('[QQ音乐评论] 处理后的评论:', comments)
          }

          // QQ 评论：热评模式下 hotComments 是精选热评，comments 是全部评论；最新模式下 hotComments 是附带的热评
          if (platform === 'qq') {
            if (data.data?.hotComments && data.data.hotComments.length > 0) {
              const hotRaw = data.data.hotComments
              const hotMapped = Array.isArray(hotRaw) ? mapQQComments(hotRaw) : []
              nextHot = hotMapped
              setHotComments(hotMapped)
            } else {
              nextHot = []
              setHotComments([])
            }
          } else {
            nextHot = []
            setHotComments([])
          }

          // 设置hasMore
          hasMoreAfter = Boolean(data.data.hasMore)
          setHasMoreComments(Boolean(data.data.hasMore))
        } else {
          debugLog('[QQ音乐评论] 无效的响应数据')
        }
      }

      // 网易云楼中楼预览还有批量 await：状态落地前再校验一次
      if (isStaleRequest()) return

      if (comments.length === 0 && reset) {
        setHasMoreComments(false)
        setAllComments([])
        return
      }

      // 更新评论列表
      if (reset) {
        const finalComments = loadMode === 'latest' ? [...comments].sort((a, b) => commentTimeValue(b.time) - commentTimeValue(a.time)) : comments
        setAllComments(finalComments)
        window.requestAnimationFrame(() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
        if (finalComments.length) {
          commentPageCache.set(cacheKey, {
            comments: finalComments,
            hot: nextHot ?? [],
            page: pageToLoad,
            hasMore: hasMoreAfter !== null ? hasMoreAfter : true,
            cursor: nextCursor ?? '-1',
          })
        }
      } else {
        setAllComments(prev => {
          const merged = new Map(prev.map(comment => [comment.commentId, comment]))
          comments.forEach(comment => merged.set(comment.commentId, comment))
          const next = Array.from(merged.values())
          return loadMode === 'latest' ? next.sort((a, b) => commentTimeValue(b.time) - commentTimeValue(a.time)) : next
        })
        // 续页也同步进缓存（仅当已有首屏缓存），重开时能恢复已加载的多页
        const existing = commentPageCache.get(cacheKey)
        if (existing) {
          const merged = new Map(existing.comments.map(comment => [comment.commentId, comment]))
          comments.forEach(comment => merged.set(comment.commentId, comment))
          commentPageCache.set(cacheKey, {
            ...existing,
            comments: Array.from(merged.values()),
            page: pageToLoad,
            hasMore: hasMoreAfter !== null ? hasMoreAfter : existing.hasMore,
            cursor: nextCursor ?? existing.cursor,
          })
        }
      }

      setCurrentPage(pageToLoad)

    } catch (err) {
      console.error('加载评论失败:', err)
      if (!isStaleRequest()) setError('加载评论失败，请重试')
    } finally {
      // 过期请求不动 loading：否则旧请求的 finally 会提前关掉新请求的加载态
      if (!isStaleRequest()) {
        if (reset) {
          setLoading(false)
        } else {
          setIsLoadingMore(false)
        }
      }
    }
  }

  // 三个列表状态（全部/热评/自己刚发的）共用同一套增删改，避免改了一处漏一处
  const patchComment = useCallback((commentId: string, patch: (comment: Comment) => Comment) => {
    const apply = (previous: Comment[]) => previous.map(comment => (comment.commentId === commentId ? patch(comment) : comment))
    setAllComments(apply)
    setHotComments(apply)
    setMyPostedComments(apply)
  }, [])

  const removeComment = useCallback((commentId: string) => {
    const drop = (previous: Comment[]) => previous.filter(comment => comment.commentId !== commentId)
    setAllComments(drop)
    setHotComments(drop)
    setMyPostedComments(drop)
  }, [])

  const findComment = useCallback((commentId: string): Comment | undefined => (
    allComments.find(comment => comment.commentId === commentId)
    ?? hotComments.find(comment => comment.commentId === commentId)
    ?? myPostedComments.find(comment => comment.commentId === commentId)
  ), [allComments, hotComments, myPostedComments])

  // 点赞评论
  const handleLike = async (comment: LikeTarget | string) => {
    const target = typeof comment === 'string' ? findComment(comment) : comment
    if (!target) return
    if (!isLoggedIn) {
      setActionError('请先登录后再进行点赞操作')
      return
    }

    const commentId = target.commentId
    const newLikeState = !target.isLiked
    const applyLike = () => patchComment(commentId, (comment) => ({
      ...comment,
      isLiked: newLikeState,
      likedCount: Math.max(0, newLikeState ? comment.likedCount + 1 : comment.likedCount - 1),
    }))

    try {
      const platform = resourcePlatform

      if (platform === 'kugou') {
        // 酷狗点赞：mlike handlelike 是 toggle，传期望态让服务端不符时自动补翻一次；
        // specialId 优先取评论自带的 special_child_id，兜底用歌曲级 childrenid（实测同值）
        const specialId = findComment(commentId)?.kugouSpecialChildId || kugouSpecialIdRef.current
        if (!specialId) {
          setActionError('评论信息不完整，无法点赞')
          return
        }
        const result = await likeKugouCommentItem(commentId, specialId, newLikeState)
        if (!result.success) {
          setActionError('点赞操作失败：' + (result.error || '未知错误'))
          return
        }
        const finalLiked = result.isLiked ?? newLikeState
        patchComment(commentId, (comment) => ({
          ...comment,
          isLiked: finalLiked,
          likedCount: Math.max(0, comment.likedCount + (finalLiked ? 1 : -1)),
        }))
      } else if (platform === 'netease') {
        const response = await fetch('http://localhost:3001/api/netease/comment/like', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: resourceId,
            type: commentType,
            commentId: commentId,
            like: newLikeState,
            cookie: userCookie
          })
        })

        const result = await response.json()

        if (response.ok && result.code === 200) {
          // 点赞成功，仅更新目标评论（其余行的 comment 引用不变，避免整表重建）
          applyLike()
        } else {
          setActionError('点赞操作失败：' + (result.message || result.error || '未知错误'))
        }
      } else {
        // QQ音乐
        const response = await fetch('http://localhost:3001/api/qq/comment/like', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            commentId: commentId,
            like: newLikeState,
            cookie: userCookie
          })
        })

        const result = await response.json()

        if (isQQCommentMutationSuccessful(result)) {
          applyLike()
        } else {
          setActionError('点赞操作失败：' + (result.error || result.message || '未知错误'))
        }
      }
    } catch (error) {
      console.error('点赞操作失败:', error)
      setActionError('点赞操作失败，请重试')
    }
  }

  // 删除评论
  const handleDelete = async (comment: { commentId: string } | string) => {
    const commentId = typeof comment === 'string' ? comment : comment.commentId
    setDeleteLoading(true)
    setActionError(null)
    setActionSuccess(null)
    try {
      const platform = resourcePlatform

      // 酷狗删除实测（2026-10-07）：commentsv2/delcomment 恒回 status=1（受理）但评论不会从
      // 列表移除（同设备身份发表+删除、15 分钟后仍可见，count 不回落）→ 删除按钮置灰（见 rowProps
      // 的 deleteDisabled），不走这个 handler；service 层 deleteKugouCommentItem 保留供后续跟进。

      if (platform === 'netease') {
        // 调用网易云API删除评论
        const response = await fetch('http://localhost:3001/api/netease/comment/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: resourceId,
            type: commentType,
            commentId: commentId,
            cookie: userCookie
          })
        })

        const result = await response.json()

        if (response.ok && result.code === 200) {
          removeComment(commentId)
          setPendingDeleteComment(null)
        } else {
          setActionError('删除评论失败：' + (result.message || result.error || '未知错误'))
        }
      } else {
        // QQ音乐删除评论API
        const response = await fetch('http://localhost:3001/api/qq/comment/del', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            commentId: commentId,
            cookie: userCookie
          })
        })

        const result = await response.json()

        if (isQQCommentMutationSuccessful(result)) {
          removeComment(commentId)
          setPendingDeleteComment(null)
        } else {
          setActionError('删除评论失败：' + (result.error || result.message || '未知错误'))
        }
      }
    } catch (error) {
      console.error('删除评论失败:', error)
      setActionError('删除评论失败，请重试')
    } finally {
      setDeleteLoading(false)
    }
  }

  const finishCommentMutation = (message: string, postedContent?: string) => {
    if (postedContent) {
      // 自己刚发的评论立刻以「我」的弹幕上屏（总览页签里描边高亮），等刷新流程接上真实数据
      const optimistic: Comment = {
        commentId: `local-${Date.now()}`,
        content: postedContent,
        user: { nickname: '我', avatarUrl: '' },
        time: Date.now(),
        likedCount: 0,
        replyCount: 0,
        replies: [],
        isOwn: true,
      }
      setMyPostedComments(previous => [optimistic, ...previous].slice(0, 3))
    }
    setNewComment('')
    setReplyingTo(null)
    setActionError(null)
    setActionSuccess(message)
    // 新评论落在「最新评论」里，直接切过去让用户看到结果
    setTab('latest')
    window.requestAnimationFrame(() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
    // 等平台完成评论索引后，再由最新视图自己的闭包刷新，避免旧的“精彩评论”请求覆盖列表。
    window.setTimeout(() => setCommentRefreshKey(value => value + 1), 900)
    window.setTimeout(() => setActionSuccess(null), 3500)
  }

  // 发布评论
  const handleSubmitComment = async () => {
    const content = newComment.trim()
    if (!content) return

    if (!isLoggedIn) {
      setActionError('请先登录后再发表评论')
      return
    }

    setActionError(null)
    setActionSuccess(null)
    setIsSubmitting(true)
    try {
      const platform = resourcePlatform

      if (platform === 'soda') {
        // 汽水发表评论：成功后乐观插入首条，再静默刷新第一页与服务端对齐
        if (isPlaylistResource) {
          setActionError('汽水歌单暂不支持发表评价')
          return
        }
        const ok = await createSodaComment(String(resourceId), content)
        if (!ok) {
          setActionError('评论发布失败，请检查登录状态后重试')
          return
        }
        const optimistic: Comment = {
          commentId: `soda-local-${Date.now()}`,
          content,
          user: { nickname: '我', avatarUrl: '' },
          time: Date.now(),
          likedCount: 0,
          replyCount: 0,
          replies: []
        }
        setNewComment('')
        setReplyingTo(null)
        setActionError(null)
        setActionSuccess('评论发表成功')
        setAllComments(prev => [optimistic, ...prev])
        setTab('latest')
        window.requestAnimationFrame(() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
        window.setTimeout(() => setActionSuccess(null), 3500)
        sodaCursorRef.current = undefined
        window.setTimeout(() => { void loadComments(true) }, 800)
        return
      }

      if (platform === 'kugou') {
        // 酷狗发表：commentsv3/add（需概念版扫码登录；频控 60062 时如实透出上游提示）
        const result = await sendKugouComment(Number(resourceId), content)
        if (!result.success) {
          setActionError('评论发布失败：' + (result.error || '未知错误'))
          return
        }
        finishCommentMutation('评论发表成功', content)
        return
      }

      if (platform === 'netease') {
        // 调用网易云API发布评论
        const response = await fetch('http://localhost:3001/api/netease/comment/add', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: resourceId,
            type: commentType,
            content,
            cookie: userCookie
          })
        })

        const result = await response.json()

        if (response.ok && result.code === 200) {
          finishCommentMutation('评论发表成功，已切换到最新评论', content)
        } else {
          setActionError('评论发布失败：' + (result.message || result.error || '未知错误'))
        }
      } else {
        // QQ音乐发布评论API
        const response = await fetch('http://localhost:3001/api/qq/comment/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: resourceId,
            content,
            biztype: qqCommentBizType,
            cookie: userCookie
          })
        })

        const result = await response.json()

        if (isQQCommentMutationSuccessful(result)) {
          finishCommentMutation('评论发表成功，已切换到最新评论', content)
        } else {
          setActionError('评论发布失败：' + (result.error || result.message || '未知错误'))
        }
      }
    } catch (error) {
      console.error('发布评论失败:', error)
      setActionError(error instanceof Error ? error.message : '发布评论失败，请重试')
    } finally {
      setIsSubmitting(false)
    }
  }

  // 回复评论（或楼中楼里的某条回复）
  const handleReply = async (target: ReplyTarget | string) => {
    const replyTarget: ReplyTarget = typeof target === 'string' ? { commentId: target, username: '' } : target
    if (!newComment.trim()) return

    if (!isLoggedIn) {
      setActionError('请先登录后再回复评论')
      return
    }

    setActionError(null)
    setActionSuccess(null)
    setIsSubmitting(true)
    try {
      const platform = resourcePlatform

      if (platform === 'kugou') {
        // 酷狗回复：commentsv2/reply，tid=被回复对象 id、pid=所属顶级评论 id（回复顶级评论传 0）
        const result = await replyKugouComment(Number(resourceId), {
          commentId: replyTarget.commentId,
          pid: replyTarget.rootId || '0',
          content: newComment,
        })
        if (!result.success) {
          setActionError('回复发布失败：' + (result.error || '未知错误'))
          return
        }
        finishCommentMutation('回复发表成功')
        return
      }

      if (platform === 'netease') {
        // 调用网易云API回复评论
        const response = await fetch('http://localhost:3001/api/netease/comment/reply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: resourceId,
            type: commentType,
            content: newComment,
            commentId: replyTarget.rootId ?? replyTarget.commentId,
            cookie: userCookie
          })
        })

        const result = await response.json()

        if (response.ok && result.code === 200) {
          finishCommentMutation('回复发表成功，已切换到最新评论')
        } else {
          setActionError('回复发布失败：' + (result.message || result.error || '未知错误'))
        }
      } else {
        // QQ 回复与顶级评论共用接口，但必须携带根评论和父评论 ID 才能形成楼中楼；
        // 回复「评论的评论」时 parentCommentId 指向被回复的那条回复
        const response = await fetch('http://localhost:3001/api/qq/comment/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: resourceId,
            content: newComment,
            biztype: qqCommentBizType,
            rootCommentId: replyTarget.rootId ?? replyTarget.commentId,
            parentCommentId: replyTarget.commentId,
            cookie: userCookie
          })
        })
        const result = await response.json()
        if (!isQQCommentMutationSuccessful(result)) {
          throw new Error(result.error || '回复发布失败')
        }
        finishCommentMutation('回复发表成功，已切换到最新评论')
      }
    } catch (error) {
      console.error('回复评论失败:', error)
      setActionError(error instanceof Error ? error.message : '回复评论失败，请重试')
    } finally {
      setIsSubmitting(false)
    }
  }

  const toggleReplies = async (comment: Comment) => {
    const willExpand = !expandedReplies.has(comment.commentId)
    setExpandedReplies(previous => {
      const next = new Set(previous)
      if (willExpand) next.add(comment.commentId)
      else next.delete(comment.commentId)
      return next
    })

    if (!willExpand) return

    // QQ：楼中楼全量走新版接口 GetReplyCommentList（RootCmId 定位楼层）
    if (resourcePlatform === 'qq') {
      // QQ 列表接口的 ReplyCnt 恒为 0：只要还没有展开拉取过，就允许拉全量
      if (comment.replyCount > 0 && (comment.replies?.length || 0) >= comment.replyCount) return
      try {
        const response = await fetch('http://localhost:3001/api/qq/comment/musicu', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            module: 'music.globalComment.CommentRead',
            method: 'GetReplyCommentList',
            param: {
              RootCmId: comment.commentId,
              LastCommentSeqNo: '', LastRankScore: '',
              PageSize: Math.min(comment.replyCount, 50), RankType: 0,
              PicEnable: 1, LastRspVer: '', PageNum: 0, SelfSeeEnable: 1, AudioEnable: 0,
            },
            cookie: userCookie,
          }),
        })
        const result = await response.json()
        const rd = result?.req
        if (!response.ok || rd?.code !== 0) throw new Error(rd?.data?.Msg || result?.error || '加载回复失败')
        const rawReplies = rd.data?.CommentList?.Comments || rd.data?.Comments || []
        if (!rawReplies.length) return
        const replies: Reply[] = rawReplies
          .map((raw: any) => {
            const mapped = mapQQCommentV2(raw)
            return {
              replyId: mapped.commentId,
              content: mapped.content,
              user: mapped.user,
              time: mapped.time,
              beRepliedUser: (raw.ParentComment?.Nick && String(raw.ParentComment.Nick)) || undefined,
              hasImage: raw.Pic ? true : undefined,
            } as Reply
          })
          // 同主列表：过滤空 id/空正文，防 React key 碰撞
          .filter((r: Reply) => r.replyId && r.content)
        patchComment(comment.commentId, item => ({ ...item, replies }))
        return
      } catch (error) {
        setActionError(error instanceof Error ? error.message : '加载回复失败，请重试')
        return
      }
    }

    // 酷狗：楼层走 /mcomment/v1/hot_replylist（childrenid = special_child_id；上游缺它返回 20006）
    if (resourcePlatform === 'kugou') {
      const specialId = comment.kugouSpecialChildId
      if (!specialId || (comment.replies?.length || 0) >= comment.replyCount) return
      try {
        const items = await fetchKugouCommentFloor({
          mixSongId: Number(resourceId) || undefined,
          specialId,
          // tid 必须是评论 id（实测：缺 tid → 10002；传 special_id → 60102）
          tid: comment.commentId,
          page: 1,
          pagesize: Math.min(Math.max(comment.replyCount, 1), 50),
        })
        const replies: Reply[] = items.map((item, index) => ({
          replyId: String(item.id || `kugou-floor-${comment.commentId}-${index}`),
          content: item.content,
          user: { nickname: item.userName, avatarUrl: item.userPic, userId: item.userId },
          time: (Number(item.addtime) || 0) * 1000,
        }))
        if (!replies.length) return
        patchComment(comment.commentId, item => ({ ...item, replies }))
      } catch (error) {
        setActionError(error instanceof Error ? error.message : '加载回复失败，请重试')
      }
      return
    }

    if (resourcePlatform !== 'netease' || (comment.replies?.length || 0) >= comment.replyCount) return

    try {
      const response = await fetch(
        `http://localhost:3001/api/netease/comment/floor?id=${encodeURIComponent(String(resourceId))}&parentCommentId=${comment.commentId}&limit=${Math.min(comment.replyCount, 50)}&type=${commentType}&cookie=${encodeURIComponent(userCookie)}`
      )
      const result = await response.json()
      if (!response.ok || result.code !== 200) throw new Error(result.message || result.error || '加载回复失败')
      const replies: Reply[] = (result.data?.comments || []).map((reply: any) => ({
        replyId: String(reply.commentId),
        content: reply.content || '',
        user: {
          nickname: reply.user?.nickname || '匿名用户',
          avatarUrl: reply.user?.avatarUrl || '',
          userId: reply.user?.userId?.toString()
        },
        time: Number(reply.time || 0),
        beRepliedUser: reply.beReplied?.[0]?.user?.nickname
      }))
      patchComment(comment.commentId, item => ({ ...item, replies }))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '加载回复失败，请重试')
    }
  }

  /** 左侧评论框获得焦点，并把回复对象带进去（可为评论或楼中楼里的一条回复） */
  // 评论用户主页弹窗（网易云：官方 user/detail + user_playlist；QQ 无网页主页）
  const [profileUser, setProfileUser] = useState<Comment | null>(null)
  // 弹幕外观设置（字号/不透明度/昵称开关，localStorage 持久化）+ 设置面板开关
  const [danmakuStyle, setDanmakuStyle] = useState<DanmakuStyleSettings>(readDanmakuStyle)
  const [showStylePanel, setShowStylePanel] = useState(false)
  useEffect(() => {
    try { localStorage.setItem(DANMAKU_STYLE_STORAGE_KEY, JSON.stringify(danmakuStyle)) } catch { /* 隐私模式忽略 */ }
  }, [danmakuStyle])

  const [profileData, setProfileData] = useState<{ loading: boolean; error: string; profile: any; playlists: any[] }>({ loading: false, error: '', profile: null, playlists: [] })
  const neteaseCookie = localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''

  const handleOpenCommentUser = useCallback((comment: Comment) => {
    if (resourcePlatform === 'netease' && comment.user.userId) {
      setProfileUser(comment)
      return
    }
    setActionError('该平台用户主页需在客户端内查看')
  }, [resourcePlatform])

  useEffect(() => {
    if (!profileUser || resourcePlatform !== 'netease' || !profileUser.user.userId) return
    const controller = new AbortController()
    setProfileData({ loading: true, error: '', profile: null, playlists: [] })
    Promise.all([
      fetch(`http://localhost:3001/api/netease/user/detail?uid=${profileUser.user.userId}&cookie=${encodeURIComponent(neteaseCookie)}`, { signal: controller.signal }).then(res => res.json()),
      fetch(`http://localhost:3001/api/netease/user/playlist?uid=${profileUser.user.userId}&limit=30&cookie=${encodeURIComponent(neteaseCookie)}`, { signal: controller.signal }).then(res => res.json()),
    ]).then(([detail, playlist]) => {
      if (controller.signal.aborted) return
      setProfileData({ loading: false, error: '', profile: detail?.profile || null, playlists: Array.isArray(playlist?.playlist) ? playlist.playlist : [] })
    }).catch(error => {
      if (!controller.signal.aborted) setProfileData({ loading: false, error: error instanceof Error ? error.message : '用户主页加载失败', profile: null, playlists: [] })
    })
    return () => controller.abort()
  }, [profileUser, resourcePlatform, neteaseCookie])

  const beginReply = useCallback((target: ReplyTarget) => {
    setReplyingTo(target)
    // 官方同款：回复自动带上 @对方（避免忘记称呼）
    setNewComment(previous => (previous.startsWith(`@${target.username} `) ? previous : `@${target.username} ${previous}`))
    window.setTimeout(() => inputRef.current?.focus(), 60)
  }, [])

  // 虚拟列表行回调走 latest-ref 稳定身份：rowProps 每次渲染都会重建，若回调是内联
  // 新函数，memo(CommentItem) 的浅比较恒失败，可见评论行全部跟着重渲染。
  const commentRowHandlersRef = useRef({ handleLike, beginReply, toggleReplies, handleOpenCommentUser, loadComments })
  commentRowHandlersRef.current = { handleLike, beginReply, toggleReplies, handleOpenCommentUser, loadComments }
  const handleRowLike = useCallback((comment: Comment) => void commentRowHandlersRef.current.handleLike(comment), [])
  const handleRowReply = useCallback((target: ReplyTarget) => commentRowHandlersRef.current.beginReply(target), [])
  const handleRowDelete = useCallback((comment: Comment) => setPendingDeleteComment(comment), [])
  const handleRowToggleReplies = useCallback((comment: Comment) => void commentRowHandlersRef.current.toggleReplies(comment), [])
  const handleRowOpenUser = useCallback((comment: Comment) => commentRowHandlersRef.current.handleOpenCommentUser(comment), [])
  const handleRowLoadMore = useCallback(() => void commentRowHandlersRef.current.loadComments(false), [])

  const submitComposer = () => {
    if (replyingTo) void handleReply(replyingTo)
    else void handleSubmitComment()
  }

  // 弹幕池：精彩评论优先，并始终并入已加载的全部评论（去重）。
  // 之前只在精彩评论少于 12 条时才补，热门歌的弹幕池永远只有热评那 15-20 条，
  // 用户会看到「弹幕翻来覆去就 20 个」；现在加载的评论越多，幕布上的弹幕越多。
  const danmakuPool = useMemo<Comment[]>(() => {
    const seen = new Set<string>()
    const pool: Comment[] = []
    const push = (comment: Comment) => {
      if (!comment.commentId || seen.has(comment.commentId) || !comment.content.trim()) return
      seen.add(comment.commentId)
      pool.push(comment)
    }
    myPostedComments.forEach(push)
    // 精选热评打上 hot 标记：弹幕气泡带描边和「热」角标
    hotComments.forEach(comment => push({ ...comment, hot: true }))
    for (const comment of allComments) {
      if (pool.length >= DANMAKU_POOL_CAP) break
      push(comment)
    }
    return pool.slice(0, DANMAKU_POOL_CAP)
  }, [myPostedComments, hotComments, allComments])

  // ===== 列表虚拟化：扁平行数组 + 动态行高 =====
  // 列表页签：QQ 的「推荐」展示精选热评（hotComments），其余页签展示各自排序加载的全量列表
  const listComments = tab === 'recommend' && resourcePlatform === 'qq' ? hotComments : allComments
  // QQ「推荐」是接口给的一批固定精选集合，不做续页；其余列表页签（含网易云推荐/最热的 offset 分页）都可加载更多
  const isFixedBatchTab = tab === 'recommend' && resourcePlatform === 'qq'
  // 金银铜排名徽章：最热评论列表，以及 QQ 推荐页签（精彩评论）
  const showRankForTab = tab === 'hot' || isFixedBatchTab
  const commentRows = useMemo<CommentRow[]>(() => {
    const rows: CommentRow[] = listComments.map((comment, index) => ({ kind: 'comment', comment, index }))
    if (!isFixedBatchTab) {
      if (hasMoreComments && !loading) rows.push({ kind: 'load-more' })
      else if (!hasMoreComments && listComments.length > 0) rows.push({ kind: 'no-more' })
    }
    return rows
  }, [listComments, isFixedBatchTab, hasMoreComments, loading])

  // 变高行：ResizeObserver 实测每行高度；估算值用于首帧定位
  const dynamicRowHeight = useDynamicRowHeight({ defaultRowHeight: 96 })
  // 评论列表虚拟化后 List 外层 div 即滚动容器，同步给 scrollContainerRef
  // （供续页判断与 ScrollToTop 使用）
  const commentListRef = useRef<ListImperativeAPI | null>(null)
  const commentOuterRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (isOpen && !loading && !error) {
      const listEl = commentListRef.current?.element ?? null
      if (listEl) scrollContainerRef.current = listEl
    }
    return () => {
      scrollContainerRef.current = commentOuterRef.current
    }
  }, [isOpen, loading, error, commentRows.length])

  // 桌面端惯例：ESC 关闭弹窗（弹幕钉住时由弹幕层先行消费）
  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  const changeSpeed = (value: number) => {
    setDanmakuSpeed(value)
    try {
      window.localStorage.setItem(DANMAKU_SPEED_STORAGE_KEY, String(value))
    } catch {
      // 隐私模式下 localStorage 可能不可写：速度仅本次会话生效
    }
  }

  if (!isOpen) return null

  // 主题令牌：深浅两套都建立在封面上，避免「全黑一片」
  const textPrimary = isDark ? 'text-white' : 'text-[rgba(16,16,20,0.92)]'
  const textSecondary = isDark ? 'text-white/55' : 'text-black/50'
  const textTertiary = isDark ? 'text-white/40' : 'text-black/38'
  const railSurface = isDark ? 'rgba(12,12,18,0.42)' : 'rgba(255,255,255,0.5)'
  const divider = isDark ? 'border-white/10' : 'border-black/8'
  const chipClass = isDark ? 'border-white/12 bg-white/8 text-white/70' : 'border-black/8 bg-black/4 text-black/55'
  const tabBase = 'rounded-full px-3.5 py-1.5 text-[13px] transition-colors'
  const tabClass = (active: boolean) => active
    ? `${tabBase} font-medium`
    : `${tabBase} ${isDark ? 'text-white/55 hover:bg-white/8 hover:text-white/85' : 'text-black/50 hover:bg-black/5 hover:text-black/75'}`

  // 页签定义：**酷狗按客户端只有三个大类「推荐 / 最热 / 最新」**（没有弹幕总览页签，
  // 进弹窗即列表 + 标签带）；其余平台保持 总览（弹幕幕布）常驻。
  // 推荐页签网易云/QQ/酷狗提供（酷狗推荐=cmtlist 混合序）；汽水无推荐排序，保持 总览/最热/最新。
  const isKugouComments = resourcePlatform === 'kugou'
  const showRecommendTab = resourcePlatform === 'netease' || resourcePlatform === 'qq' || isKugouComments
  const tabs: { key: CommentTab; label: string; badge?: number }[] = [
    // 酷狗不提供弹幕总览页签（客户端没有这一层）
    ...(isKugouComments
      ? []
      : [{ key: 'overview' as CommentTab, label: '总览', badge: totalComments > 0 ? Number(totalComments) : danmakuPool.length }]),
    ...(showRecommendTab
      ? [{ key: 'recommend' as CommentTab, label: '推荐', badge: resourcePlatform === 'qq' ? hotComments.length : undefined }]
      : []),
    { key: 'hot', label: isPlaylistResource ? '热门评价' : (isKugouComments ? '最热' : '最热评论') },
    { key: 'latest', label: isPlaylistResource ? '最新评价' : (isKugouComments ? '最新' : '最新评论') },
  ]

  const listBody = () => {
    if (loading) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-current border-t-transparent" style={{ color: accent }} />
          <p className={`text-[13px] ${textSecondary}`}>加载评论中…</p>
        </div>
      )
    }
    if (error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <p className={`text-[13px] ${textSecondary}`}>{error}</p>
          <button
            type="button"
            onClick={() => void loadComments(true)}
            className={`rounded-full border px-4 py-1.5 text-[13px] transition-colors ${chipClass}`}
          >
            重试
          </button>
        </div>
      )
    }
    if (listComments.length === 0) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1.5">
          <p className={`text-[13px] ${textSecondary}`}>
            {tab === 'hot' || isFixedBatchTab
              ? '这首歌还没有精彩评论'
              : (isPlaylistResource ? '暂无评价，快来发表第一条评价吧' : '暂无评论，快来发表第一条评论吧')}
          </p>
          {(tab === 'hot' || isFixedBatchTab) && (
            <button
              type="button"
              onClick={() => setTab('latest')}
              className="text-[12px] transition-opacity hover:opacity-80"
              style={{ color: accent }}
            >
              去看最新评论
            </button>
          )}
        </div>
      )
    }
    // 酷狗标签 chips：客户端是**同一条流式换行**的标签带——先是分类标签
    // （全部 · 歌曲相关 / 有图 / …，来自 cmtlist 的 classify_list），紧接着热词
    // （来自 hot_word_list），整体 flex-wrap 自然折行。此前分成两条带边框的行，
    // 只有单个热词时会出现「宝藏」独占一行的观感（用户反馈）。
    const showKugouTagChips = resourcePlatform === 'kugou' && !isPlaylistResource && (kugouClassify.length > 0 || kugouHotWords.length > 0)
    const kugouTagChips = showKugouTagChips ? (
      <div className={`flex shrink-0 flex-wrap items-center gap-1.5 border-b px-6 py-2.5 ${divider}`}>
        <button
          type="button"
          onClick={() => { setKugouActiveClassify(''); setKugouActiveWord('') }}
          className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${chipClass}`}
          style={!kugouActiveClassify && !kugouActiveWord ? { background: `${accent}26`, color: accent, borderColor: accent } : undefined}
        >
          全部{totalComments > 0 ? ` · ${totalComments}` : ''}
        </button>
        {kugouClassify.map(item => (
          <button
            key={`classify-${item.id}`}
            type="button"
            onClick={() => {
              setKugouActiveWord('')
              setKugouActiveClassify(current => (current === item.id ? '' : item.id))
            }}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${chipClass}`}
            style={kugouActiveClassify === item.id ? { background: `${accent}26`, color: accent, borderColor: accent } : undefined}
          >
            {item.name}
            {item.count > 0 ? ` · ${item.count}` : ''}
          </button>
        ))}
        {kugouHotWords.map(item => (
          <button
            key={`word-${item.word}`}
            type="button"
            onClick={() => {
              setKugouActiveClassify('')
              setKugouActiveWord(current => (current === item.word ? '' : item.word))
            }}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${chipClass}`}
            style={kugouActiveWord === item.word ? { background: `${accent}26`, color: accent, borderColor: accent } : undefined}
          >
            {item.word}
            {item.count > 0 ? ` · ${item.count}` : ''}
          </button>
        ))}
      </div>
    ) : null
    return (
      <div className="flex h-full flex-col">
        {kugouTagChips}
        <div className="min-h-0 flex-1">
          <List<CommentRowData>
            listRef={commentListRef}
            className="custom-scrollbar"
            style={{ height: '100%', width: '100%' }}
            onScroll={handleScroll}
            rowCount={commentRows.length}
            rowHeight={dynamicRowHeight}
            overscanCount={6}
            rowComponent={CommentVirtualRow}
            rowProps={{
              rows: commentRows,
              expandedReplies,
              isLoggedIn,
              canInteract,
              currentUserId,
              isDark,
              accent,
              showRank: showRankForTab,
              deleteDisabled: resourcePlatform === 'kugou',
              onLike: handleRowLike,
              onReply: handleRowReply,
              onDelete: handleRowDelete,
              onToggleReplies: handleRowToggleReplies,
              onOpenUser: handleRowOpenUser,
              onPreviewImage: setPreviewImage,
              isLoadingMore,
              onLoadMore: handleRowLoadMore,
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-6"
        data-tv-scope
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.96, opacity: 0, y: 12 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0, y: 12 }}
          transition={{ type: 'spring', damping: 26, stiffness: 320 }}
          // 横向大矩形（PC）：左栏歌曲信息与评论框，右栏页签内容；最小高度避免小窗退化回竖向卡片
          className={`relative flex h-[min(820px,90vh)] min-h-[540px] w-[min(1320px,95vw)] overflow-hidden rounded-[26px] border shadow-2xl ${
            isDark ? 'border-white/12' : 'border-black/10'
          }`}
          onClick={(e) => e.stopPropagation()}
          style={{
            // 全不透明底色：弹窗常盖在播放中的 MV 视频/动态页面上，半透明底 +
            // 滤镜层会制造多层合成边界，诱发 Chromium 光栅化闪烁
            background: isDark ? '#0b0b10' : '#f6f6f3',
          }}
        >
          {/* 封面背景层：用元素自身 filter 预先把封面糊化（内容静态，合成器只算一次）。
              不要改回 backdrop-filter——弹窗盖在持续动画的播放页（摩登动态封面/逐字歌词）上时，
              backdrop-filter 每帧重采样背景会触发 Chromium 合成器出陈旧帧，评论区肉眼可见地闪。 */}
          {resourceCoverUrl && (
            <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
              <div
                className="absolute -inset-24"
                style={{
                  backgroundImage: `url(${resourceBackgroundUrl})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  filter: isDark ? 'blur(72px) saturate(1.5) brightness(0.68)' : 'blur(72px) saturate(1.35) brightness(1.12)',
                }}
              />
            </div>
          )}
          <div
            className="absolute inset-0"
            aria-hidden="true"
            style={{
              background: isDark
                ? 'linear-gradient(135deg, rgba(10,10,16,0.7) 0%, rgba(6,6,11,0.82) 55%, rgba(12,12,19,0.74) 100%)'
                : 'linear-gradient(135deg, rgba(255,255,255,0.8) 0%, rgba(248,248,246,0.88) 55%, rgba(240,240,238,0.84) 100%)',
            }}
          />
          {/* 封面色氛围光：让界面颜色跟着这首歌走，而不是一片死黑 */}
          <div
            className="absolute inset-0"
            aria-hidden="true"
            style={{ background: `radial-gradient(58% 52% at 10% 6%, ${accent}2e 0%, transparent 68%)` }}
          />

          {/* ===== 左栏：资源信息 + 常驻评论框 ===== */}
          <aside
            className={`relative z-10 flex w-[300px] shrink-0 flex-col border-r xl:w-[336px] ${divider}`}
            style={{ background: railSurface }}
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto custom-scrollbar px-6 pb-4 pt-6">
              <div className="flex items-start justify-between gap-3">
                <div className="h-[152px] w-[152px] shrink-0 overflow-hidden rounded-2xl shadow-2xl xl:h-[168px] xl:w-[168px]">
                  {resourceCoverUrl ? (
                    <CachedImage
                      src={resourceCoverUrl}
                      alt={resourceName}
                      className="h-full w-full object-cover"
                      role="compact"
                      size={336}
                      priority="critical"
                      lazy={false}
                    />
                  ) : (
                    <div className={`flex h-full w-full items-center justify-center ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
                      <Gauge className={`h-8 w-8 ${textTertiary}`} />
                    </div>
                  )}
                </div>
              </div>

              <h2 className={`mt-4 line-clamp-2 text-[19px] font-bold leading-7 ${textPrimary}`} title={resourceName}>
                {resourceName}
              </h2>
              {resourceSubtitle && (
                <p className={`mt-1 truncate text-[13px] ${textSecondary}`} title={resourceSubtitle}>
                  {resourceSubtitle}
                </p>
              )}
              {resourceAlbumName && (
                <p className={`mt-0.5 truncate text-[12px] ${textTertiary}`} title={resourceAlbumName}>
                  专辑 · {resourceAlbumName}
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2.5 py-0.5 text-[11px] ${chipClass}`}>
                  {platformLabel(resourcePlatform)}
                </span>
                {totalComments > 0 && (
                  <span className={`rounded-full border px-2.5 py-0.5 text-[11px] ${chipClass}`}>
                    共 {totalComments.toLocaleString('zh-CN')} 条评论
                  </span>
                )}
                {isPlaylistResource && typeof playlist?.commentCount === 'number' && playlist.commentCount > 0 && (
                  <span className={`rounded-full border px-2.5 py-0.5 text-[11px] ${chipClass}`}>
                    评价 {playlist.commentCount}
                  </span>
                )}
                {shareCount > 0 && (
                  <span className={`rounded-full border px-2.5 py-0.5 text-[11px] ${chipClass}`}>
                    {shareCount} 次分享
                  </span>
                )}
              </div>

              {isPlaylistResource && playlist && (
                <div className={`mt-4 rounded-2xl border p-3.5 text-[12px] leading-5 ${divider} ${isDark ? 'bg-white/4' : 'bg-white/50'}`}>
                  <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${textSecondary}`}>
                    {playlist.creator?.avatarUrl && (
                      <CachedImage src={playlist.creator.avatarUrl} alt={playlist.creator.nickname || '创建者'} className="h-6 w-6 rounded-full object-cover" role="row" size={48} priority="visible" />
                    )}
                    <span>创建者：{playlist.creator?.nickname || '未知用户'}</span>
                    {playlist.createTime && <span>创建于 {new Date(playlist.createTime).toLocaleDateString('zh-CN')}</span>}
                  </div>
                  <div className={`mt-2 whitespace-pre-wrap ${isDark ? 'text-white/70' : 'text-black/65'}`}>{playlistDescription}</div>
                  {Array.isArray(playlist.tags) && playlist.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {playlist.tags.map(tag => (
                        <span key={tag} className={`rounded-full border px-2 py-0.5 text-[11px] ${chipClass}`}>{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 热评速览：堆叠卡组（最热 3 条），点一下直接去弹幕幕布。
                  酷狗没有总览页签 → 不渲染这组跳转卡（点了没有去处）。 */}
              {hotComments[0] && !isPlaylistResource && resourcePlatform !== 'kugou' && (
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => setTab('overview')}
                    className={`relative z-10 w-full rounded-2xl border p-3.5 text-left transition-colors ${divider} ${
                      isDark ? 'bg-white/4 hover:bg-white/8' : 'bg-white/55 hover:bg-white/80'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className={`text-[11px] ${textTertiary}`}>最热评论</span>
                      <span className="text-[11px]" style={{ color: accent }}>去弹幕看 →</span>
                    </div>
                    <div className={`mt-1.5 line-clamp-3 text-[12.5px] leading-5 ${isDark ? 'text-white/80' : 'text-black/70'}`}>
                      {hotComments[0].content}
                    </div>
                    <div className={`mt-1.5 flex items-center gap-2 text-[11px] ${textTertiary}`}>
                      <span className="truncate">{hotComments[0].user.nickname}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        <ThumbsUp className="h-3 w-3" />
                        {hotComments[0].likedCount}
                      </span>
                    </div>
                  </button>
                  {/* 下方补充：第二、三条热评的紧凑预览，填补留白 */}
                  {hotComments.slice(1, 3).map((hot, hotIndex) => (
                    <button
                      key={hot.commentId}
                      type="button"
                      onClick={() => setTab('overview')}
                      className={`mt-2 w-full rounded-xl border px-3 py-2 text-left transition-colors ${divider} ${
                        isDark ? 'bg-white/[0.025] hover:bg-white/[0.06]' : 'bg-white/40 hover:bg-white/70'
                      }`}
                    >
                      <div className={`line-clamp-1 text-[12px] leading-5 ${isDark ? 'text-white/65' : 'text-black/60'}`}>{hot.content}</div>
                      <div className={`mt-0.5 flex items-center gap-2 text-[10.5px] ${textTertiary}`}>
                        <span className="truncate">{hot.user.nickname}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          <ThumbsUp className="h-2.5 w-2.5" />
                          {hot.likedCount}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 发表评论：PC 端常驻输入区，不再藏在「发表评论」按钮后面 */}
            <div className={`shrink-0 border-t px-5 py-4 ${divider}`}>
              {showEmojiPanel && (
                <div className={`mb-2 flex flex-wrap gap-1 rounded-xl border p-2 ${divider} ${isDark ? 'bg-black/25' : 'bg-white/60'}`}>
                  {COMPOSER_EMOJIS.map(emoji => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setNewComment(value => value + emoji)}
                      className={`rounded-lg px-1.5 py-0.5 text-[16px] leading-6 transition-colors ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/6'}`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
              {replyingTo && (
                <div
                  className="mb-2 flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[11px]"
                  style={{ background: `${accent}1f`, color: accent }}
                >
                  <span className="truncate">回复 @{replyingTo.username}</span>
                  <button type="button" onClick={() => setReplyingTo(null)} className="shrink-0 opacity-70 hover:opacity-100">
                    取消
                  </button>
                </div>
              )}
              <textarea
                ref={inputRef}
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder={composerPlaceholder}
                disabled={composerLocked}
                className={`custom-scrollbar h-[76px] w-full resize-none rounded-xl border px-3.5 py-3 text-[13px] leading-5 transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
                  isDark
                    ? 'border-white/12 bg-black/25 text-white placeholder:text-white/35'
                    : 'border-black/8 bg-white/70 text-[rgba(16,16,20,0.9)] placeholder:text-black/35'
                }`}
                style={{ boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.06)' }}
                onFocus={(e) => { e.currentTarget.style.borderColor = accent }}
                onBlur={(e) => { e.currentTarget.style.borderColor = '' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submitComposer()
                  }
                }}
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className={`flex items-center gap-2 text-[11px] ${textTertiary}`}>
                  {!composerLocked && (
                    <>
                      <button
                        type="button"
                        onClick={() => setNewComment(value => `${value}@`)}
                        aria-label="提及用户"
                        title="插入 @"
                        className={`flex h-6 w-6 items-center justify-center rounded-full text-[13px] font-medium transition-colors ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/6'}`}
                      >
                        @
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowEmojiPanel(value => !value)}
                        aria-label="表情"
                        className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/6'}`}
                        style={showEmojiPanel ? { color: accent } : undefined}
                      >
                        <Smile className="h-4 w-4" />
                      </button>
                    </>
                  )}
                  {composerLocked
                    ? (resourcePlatform === 'kugou'
                      ? (isLoggedIn ? '酷狗歌单评论暂未提供（仅支持单曲评论）' : '扫码登录酷狗后可发表/点赞/回复')
                      : '登录后可参与评论')
                    : 'Enter 发送 · Shift+Enter 换行'}
                </span>
                <button
                  type="button"
                  onClick={submitComposer}
                  disabled={composerLocked || !newComment.trim() || isSubmitting}
                  className="flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[13px] font-medium text-white transition-all disabled:cursor-not-allowed disabled:opacity-45"
                  style={{ background: accent }}
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>{isSubmitting ? '发送中…' : '发送'}</span>
                </button>
              </div>
              <AnimatePresence>
                {actionError && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">
                      <span className="min-w-0 break-words">{actionError}</span>
                      <button type="button" onClick={() => setActionError(null)} className="shrink-0 opacity-70 hover:opacity-100">×</button>
                    </div>
                  </motion.div>
                )}
                {actionSuccess && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-300">
                      <span className="min-w-0 break-words">{actionSuccess}</span>
                      <button type="button" onClick={() => setActionSuccess(null)} className="shrink-0 opacity-70 hover:opacity-100">×</button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </aside>

          {/* ===== 右栏：页签 + 内容 ===== */}
          <section className="relative z-10 flex min-w-0 flex-1 flex-col">
            <header className={`flex h-[64px] shrink-0 items-center gap-3 border-b px-5 ${divider}`}>
              <div className={`flex items-center gap-1 rounded-full border p-1 ${divider} ${isDark ? 'bg-black/25' : 'bg-white/60'}`}>
                {tabs.map(item => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setTab(item.key)}
                    className={tabClass(tab === item.key)}
                    style={tab === item.key ? { background: `${accent}26`, color: accent } : undefined}
                  >
                    {item.label}
                    {typeof item.badge === 'number' && item.badge > 0 && (
                      <span className={`ml-1.5 text-[11px] ${tab === item.key ? '' : textTertiary}`}>
                        {item.badge >= 100000000 ? `${(item.badge / 100000000).toFixed(1)}亿` : item.badge >= 10000 ? `${(item.badge / 10000).toFixed(1)}万` : item.badge}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="ml-auto flex items-center gap-3">
                {tab === 'overview' && (
                  <div className="relative flex items-center gap-2">
                    <Gauge className="h-4 w-4" style={{ color: accent }} />
                    <div className={`flex items-center gap-0.5 rounded-full border p-0.5 ${divider} ${isDark ? 'bg-black/25' : 'bg-white/60'}`}>
                      {DANMAKU_SPEEDS.map(value => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => changeSpeed(value)}
                          className={`rounded-full px-2.5 py-1 text-[12px] transition-colors ${
                            danmakuSpeed === value
                              ? 'font-medium text-white'
                              : isDark ? 'text-white/50 hover:text-white/80' : 'text-black/45 hover:text-black/75'
                          }`}
                          style={danmakuSpeed === value ? { background: accent } : undefined}
                        >
                          {value}x
                        </button>
                      ))}
                    </div>
                    {/* 弹幕外观设置 */}
                    <button
                      type="button"
                      onClick={() => setShowStylePanel(value => !value)}
                      aria-label="弹幕样式设置"
                      title="弹幕样式设置"
                      className={`flex h-8 w-8 items-center justify-center rounded-full border transition-colors ${divider} ${
                        isDark ? 'bg-black/25 text-white/55 hover:text-white' : 'bg-white/60 text-black/50 hover:text-black/80'
                      }`}
                      style={showStylePanel ? { borderColor: accent, color: accent } : undefined}
                    >
                      <Settings2 className="h-4 w-4" />
                    </button>
                    {showStylePanel && (
                      <div
                        className={`absolute right-0 top-10 z-30 w-64 rounded-2xl border p-3.5 ${divider} ${
                          isDark ? 'border-white/12 bg-[#101319] shadow-2xl' : 'border-black/8 bg-white shadow-xl'
                        }`}
                        onClick={event => event.stopPropagation()}
                      >
                        <p className={`mb-2 text-[11px] font-medium ${textTertiary}`}>字号</p>
                        <div className="mb-3 flex gap-1.5">
                          {DANMAKU_FONT_SCALES.map(scale => (
                            <button
                              key={scale}
                              type="button"
                              onClick={() => setDanmakuStyle(previous => ({ ...previous, fontScale: scale }))}
                              className={`flex-1 rounded-full px-2 py-1 text-[12px] transition-colors ${divider} border ${
                                danmakuStyle.fontScale === scale ? 'font-medium' : isDark ? 'text-white/55' : 'text-black/50'
                              }`}
                              style={danmakuStyle.fontScale === scale ? { background: `${accent}26`, color: accent, borderColor: accent } : undefined}
                            >
                              {scale === 0.85 ? '小' : scale === 1 ? '标准' : '大'}
                            </button>
                          ))}
                        </div>
                        <p className={`mb-2 text-[11px] font-medium ${textTertiary}`}>不透明度</p>
                        <div className="mb-3 flex gap-1.5">
                          {DANMAKU_OPACITIES.map(opacity => (
                            <button
                              key={opacity}
                              type="button"
                              onClick={() => setDanmakuStyle(previous => ({ ...previous, opacity }))}
                              className={`flex-1 rounded-full px-2 py-1 text-[12px] transition-colors ${divider} border ${
                                danmakuStyle.opacity === opacity ? 'font-medium' : isDark ? 'text-white/55' : 'text-black/50'
                              }`}
                              style={danmakuStyle.opacity === opacity ? { background: `${accent}26`, color: accent, borderColor: accent } : undefined}
                            >
                              {opacity === 0.65 ? '淡' : opacity === 0.85 ? '适中' : '浓'}
                            </button>
                          ))}
                        </div>
                        <label className="flex cursor-pointer items-center justify-between text-[12px]">
                          <span className={isDark ? 'text-white/70' : 'text-black/60'}>显示昵称</span>
                          <input
                            type="checkbox"
                            checked={danmakuStyle.showNickname}
                            onChange={event => setDanmakuStyle(previous => ({ ...previous, showNickname: event.target.checked }))}
                            className="h-4 w-4"
                            style={{ accentColor: accent }}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                )}

                <button
                  type="button"
                  onClick={onClose}
                  aria-label="关闭评论"
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                    isDark ? 'text-white/60 hover:bg-white/10 hover:text-white' : 'text-black/50 hover:bg-black/5 hover:text-black/80'
                  }`}
                >
                  <X className="h-4.5 w-4.5" />
                </button>
              </div>
            </header>

            <div className="relative min-h-0 flex-1">
              {tab === 'overview' ? (
                <CommentDanmaku
                  comments={danmakuPool}
                  coverUrl={resourceBackgroundUrl || resourceCoverUrl}
                  playerTheme={playerTheme}
                  accentColor={accentColor}
                  speed={danmakuSpeed}
                  style={danmakuStyle}
                  isLoggedIn={isLoggedIn}
                  canInteract={canInteract}
                  onLike={(comment) => void handleLike(comment)}
                  onReply={(comment) => beginReply({ commentId: comment.commentId, username: comment.user.nickname })}
                  onDelete={(comment) => {
                    if (resourcePlatform === 'kugou') {
                      // 酷狗删除实测：接口受理但列表不移除 → 不弹确认框，如实说明
                      setActionError('酷狗评论删除上游未生效（接口受理但列表不移除），暂不提供')
                      return
                    }
                    setPendingDeleteComment(comment as Comment)
                  }}
                />
              ) : (
                <div ref={(el) => { commentOuterRef.current = el }} className="h-full">
                  {listBody()}
                </div>
              )}
            </div>
          </section>
        </motion.div>
      </motion.div>

      <DeleteCommentModal
        show={Boolean(pendingDeleteComment)}
        loading={deleteLoading}
        onClose={() => {
          if (!deleteLoading) setPendingDeleteComment(null)
        }}
        onConfirm={() => {
          if (pendingDeleteComment) void handleDelete(pendingDeleteComment)
        }}
      />

      {/* 评论图片预览：缩略图点开后按原图比例铺满可视区（不超过 92vw×88vh），
          点背景/右上角关闭。z 值高于评论弹窗本体与用户资料弹窗。 */}
      <AnimatePresence>
        {previewImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[130] flex items-center justify-center bg-black/88 p-6"
            onClick={() => setPreviewImage(null)}
            role="dialog"
            aria-label="评论图片预览"
          >
            <button
              type="button"
              onClick={() => setPreviewImage(null)}
              aria-label="关闭图片预览"
              className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white/80 transition hover:bg-white/20 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
            <img
              src={previewImage}
              alt="评论图片"
              draggable={false}
              className="max-h-[88vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 回到顶部按钮 - 相对于评论弹窗定位 */}
      {tab !== 'overview' && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[110] flex items-center justify-center p-6"
          style={{ pointerEvents: 'none' }}
        >
          <div className="relative h-[min(820px,90vh)] w-[min(1320px,95vw)]" style={{ pointerEvents: 'none' }}>
            <div className="absolute bottom-6 right-6" style={{ pointerEvents: 'auto' }}>
              <ScrollToTop
                containerRef={scrollContainerRef}
                threshold={200}
                playerTheme={playerTheme}
                position="absolute"
                offsetRight={0}
                offsetBottom={0}
              />
            </div>
          </div>
        </motion.div>
      )}

      {/* 评论用户主页弹窗（网易云） */}
      {profileUser && resourcePlatform === 'netease' && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-5 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="用户主页" onMouseDown={event => { if (event.target === event.currentTarget) setProfileUser(null) }}>
          <div className="max-h-[82vh] w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#101319] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
              <h3 className="text-lg font-semibold text-white">用户主页</h3>
              <button type="button" onClick={() => setProfileUser(null)} className="flex h-8 w-8 items-center justify-center rounded-full text-white/45 hover:bg-white/[0.07] hover:text-white" aria-label="关闭">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[68vh] overflow-y-auto p-5">
              {profileData.loading ? (
                <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-white/50" /></div>
              ) : profileData.error ? (
                <p className="py-6 text-center text-sm text-rose-200/80">{profileData.error}</p>
              ) : profileData.profile ? (
                <div className="space-y-5">
                  <div className="flex items-center gap-4">
                    {profileData.profile.avatarUrl && (
                      <img src={profileData.profile.avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-lg font-semibold text-white">{profileUser.user.nickname}</p>
                      {profileData.profile.signature && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/45">{profileData.profile.signature}</p>}
                      <p className="mt-1 flex gap-3 text-[11px] text-white/40">
                        <span>动态 {profileData.profile.eventCount ?? 0}</span>
                        <span>关注 {profileData.profile.follows ?? 0}</span>
                        <span>粉丝 {profileData.profile.followeds ?? 0}</span>
                        {typeof profileData.profile.level === 'number' && <span>Lv.{profileData.profile.level}</span>}
                      </p>
                    </div>
                  </div>
                  <div>
                    <h4 className="mb-2 text-sm font-semibold text-white/85">TA 的歌单</h4>
                    {profileData.playlists.length === 0 ? (
                      <p className="py-4 text-center text-sm text-white/40">暂无公开歌单</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {profileData.playlists.map((playlist: any) => (
                          <button
                            key={String(playlist.id)}
                            type="button"
                            onClick={() => { onOpenPlaylistProp?.({ id: String(playlist.id), name: String(playlist.name || ''), coverUrl: String(playlist.coverImgUrl || ''), platform: 'netease' }); setProfileUser(null) }}
                            className="group w-full text-left"
                          >
                            <span className="relative block aspect-square overflow-hidden rounded-lg bg-white/[0.05]">
                              {playlist.coverImgUrl && <img src={playlist.coverImgUrl} alt="" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" loading="lazy" />}
                            </span>
                            <span className="mt-1.5 block line-clamp-1 text-xs text-white/80">{playlist.name}</span>
                            <span className="block text-[10px] text-white/35">{Number(playlist.playCount || 0) >= 10000 ? `${(Number(playlist.playCount) / 10000).toFixed(1)}万次播放` : `${playlist.playCount || 0}次播放`}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {/* 自定义滚动条样式 */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: ${isDark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.16)'};
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: ${isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.26)'};
        }
      `}</style>
    </AnimatePresence>
  )
}
)
