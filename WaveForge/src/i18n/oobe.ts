/**
 * OOBE 1（首次引导）文案 · 7 语言
 * 结构：key → { 语言码: 文案 }，`{n}` 为倒计时占位符。
 * 繁体三个版本：以中国台湾繁体为基底，香港/澳门版由 deriveTraditional 派生（仅替换区域性用词）。
 */
import type { LocaleCode } from './index'
import { deriveTraditional } from './index'

export type OobeStringKey =
  | 'themeTitle' | 'themeSubtitle' | 'themeDark' | 'themeLight' | 'themeNext'
  | 'privacyIntro1' | 'privacyIntro2'
  | 'privacyTitle' | 'privacyIntro' | 'privacyItem1' | 'privacyItem2' | 'privacyItem3' | 'privacyItem4' | 'privacyItem5'
  | 'back'
  | 'confirmTpl'
  | 'disclaimerIntro1' | 'disclaimerIntro2'
  | 'disclaimerTitle' | 'disclaimerSubtitle'
  | 'disclaimerItem1' | 'disclaimerItem2' | 'disclaimerItem3' | 'disclaimerItem4' | 'disclaimerItem5'
  | 'disclaimerItem6' | 'disclaimerItem7' | 'disclaimerItem8' | 'disclaimerItem9' | 'disclaimerItem10'
  | 'disclaimerItem11' | 'disclaimerItem12' | 'disclaimerItem13' | 'disclaimerItem14' | 'disclaimerItem15'
  | 'disclaimerHint' | 'legalLink'
  | 'exit' | 'agreeTpl' | 'readingHint'
  | 'finalTitle' | 'finalP1' | 'finalP2' | 'finalP3' | 'finalP4'
  | 'welcomeLine' | 'welcomeEnter'
  | 'legalModalTitle' | 'legalModalClose' | 'ariaClose'

type LangMap = Record<LocaleCode, string>

/** 单条文案构建：简中 / 台繁 / 英 / 日 / 韩（港繁、澳繁自动派生） */
const zh = (cn: string, tw: string, en: string, ja: string, ko: string): LangMap => ({
  'zh-CN': cn,
  'zh-TW': tw,
  'zh-HK': deriveTraditional(tw, 'zh-HK'),
  'zh-MO': deriveTraditional(tw, 'zh-MO'),
  en,
  ja,
  ko,
})

export const OOBE_STRINGS: Record<OobeStringKey, LangMap> = {
  themeTitle: zh('请您选择您的颜色模式', '請您選擇您的顏色模式', 'Please choose your color mode', 'カラーモードを選択してください', '색상 모드를 선택해 주세요'),
  themeSubtitle: zh(
    '选择您喜欢的界面主题，之后可在设置中随时更改。',
    '選擇您喜歡的介面主題，之後可在設定中隨時更改。',
    'Choose the interface theme you like. You can change it anytime in Settings.',
    'お好みのテーマを選択してください。後で設定からいつでも変更できます。',
    '마음에 드는 인터페이스 테마를 선택하세요. 설정에서 언제든 변경할 수 있습니다.',
  ),
  themeDark: zh('深色', '深色', 'Dark', 'ダーク', '다크'),
  themeLight: zh('浅色', '淺色', 'Light', 'ライト', '라이트'),
  themeNext: zh('下一页', '下一頁', 'Next', '次へ', '다음'),

  privacyIntro1: zh(
    '我们充分尊重您的隐私',
    '我們充分尊重您的隱私',
    'We fully respect your privacy',
    '私たちはあなたのプライバシーを最大限に尊重します',
    '저희는 여러분의 개인정보를 최대한 존중합니다',
  ),
  privacyIntro2: zh(
    '请您阅读我们的隐私条款',
    '請您閱讀我們的隱私條款',
    'Please read our privacy policy',
    'プライバシーポリシーをお読みください',
    '개인정보 처리방침을 읽어 주세요',
  ),
  privacyTitle: zh('隐私条款', '隱私條款', 'Privacy Policy', 'プライバシーポリシー', '개인정보 처리방침'),
  privacyIntro: zh(
    '本软件以保护您的隐私为原则，请知悉：',
    '本軟體以保護您的隱私為原則，請知悉：',
    'This software is built on the principle of protecting your privacy. Please note:',
    '本ソフトウェアはあなたのプライバシー保護を原則としています。ご確認ください：',
    '본 소프트웨어는 개인정보 보호를 원칙으로 합니다. 확인해 주세요:',
  ),
  privacyItem1: zh(
    '本软件不收集您的任何个人信息，默认无任何统计与追踪行为；',
    '本軟體不收集您的任何個人資訊，預設無任何統計與追蹤行為；',
    'This software does not collect any of your personal information and performs no tracking or analytics by default;',
    '本ソフトウェアは個人情報を一切収集せず、既定では統計・追跡を行いません；',
    '본 소프트웨어는 어떠한 개인정보도 수집하지 않으며, 기본적으로 통계·추적을 하지 않습니다;',
  ),
  privacyItem2: zh(
    '本软件没有任何自建服务器，登录凭证与播放缓存仅保存在您的本机（明文存储），不会上传；',
    '本軟體沒有任何自建伺服器，登入憑證與播放快取僅保存在您的本機（明文儲存），不會上傳；',
    'This software has no self-hosted servers. Login credentials and playback cache are stored only on your device (in plain text) and are never uploaded;',
    '本ソフトウェアは自社サーバーを持ちません。ログイン情報と再生キャッシュは端末内にのみ保存され（平文）、アップロードされません；',
    '본 소프트웨어는 자체 서버가 없으며, 로그인 정보와 재생 캐시는 기기 내에만 저장되고(평문) 업로드되지 않습니다;',
  ),
  privacyItem3: zh(
    '不会向任何平台、第三方机构或个人传输、披露或出售您的数据；',
    '不會向任何平台、第三方機構或個人傳輸、揭露或出售您的資料；',
    'Your data is never transmitted, disclosed, or sold to any platform, third party, or individual;',
    'あなたのデータが第三者機関や個人、プラットフォームに送信・開示・販売されることはありません；',
    '귀하의 데이터는 어떤 플랫폼·제3자 기관·개인에게도 전송, 공개, 판매되지 않습니다;',
  ),
  privacyItem4: zh(
    '软件仅与各官方平台建立必要连接以提供功能，除此之外不进行任何其他连接；',
    '軟體僅與各官方平台建立必要連線以提供功能，除此之外不進行任何其他連線；',
    'The software only establishes the necessary connections with official platforms to provide its features, and nothing else;',
    '本ソフトウェアは機能提供に必要な公式プラットフォームとの接続のみ行い、それ以外の接続は一切行いません；',
    '본 소프트웨어는 기능 제공에 필요한 공식 플랫폼 연결만 수행하며, 그 외의 연결은 하지 않습니다;',
  ),
  privacyItem5: zh(
    '您可随时清除缓存、删除设备识别码与测试码（删除操作不可逆）。',
    '您可隨時清除快取、刪除裝置識別碼與測試碼（刪除操作不可復原）。',
    'You can clear the cache, delete the device ID and test codes at any time (deletion is irreversible).',
    'キャッシュの削除、デバイス識別子とテストコードの削除はいつでも可能です（削除は元に戻せません）。',
    '캐시 삭제, 기기 식별자와 테스트 코드 삭제는 언제든 가능합니다(삭제는 되돌릴 수 없습니다).',
  ),
  back: zh('上一页', '上一頁', 'Back', '戻る', '이전'),
  confirmTpl: zh('确认（{n}）', '確認（{n}）', 'Confirm ({n})', '確認（{n}）', '확인({n})'),

  disclaimerIntro1: zh(
    '请您充分阅读以下用户须知与免责声明',
    '請您充分閱讀以下使用者須知與免責聲明',
    'Please read the following user notice and disclaimer carefully',
    '以下の利用上の注意と免責事項をよくお読みください',
    '다음 이용 안내와 면책 조항을 충분히 읽어 주세요',
  ),
  disclaimerIntro2: zh(
    '若协议中有您不同意的内容，可随时点击退出按钮',
    '若協議中有您不同意的內容，可隨時點擊退出按鈕',
    'If there is anything in this agreement you do not agree with, you may click the Exit button at any time',
    '本規約にご同意いただけない内容がある場合は、いつでも「終了」ボタンをクリックしてください',
    '본 약관 중 동의하지 않는 내용이 있다면 언제든지 종료 버튼을 클릭할 수 있습니다',
  ),
  disclaimerTitle: zh(
    '用户须知与免责声明',
    '使用者須知與免責聲明',
    'User Notice & Disclaimer',
    '利用上の注意と免責事項',
    '이용 안내 및 면책 조항',
  ),
  disclaimerSubtitle: zh(
    '以下要点正在逐条显示，请仔细阅读：',
    '以下要點正在逐條顯示，請仔細閱讀：',
    'The following points are being displayed one by one. Please read them carefully:',
    '以下の要点を順番に表示しています。よくお読みください：',
    '다음 핵심 사항이 하나씩 표시됩니다. 주의 깊게 읽어 주세요:',
  ),

  disclaimerItem1: zh(
    '本软件为独立开发的第三方播放器，与网易云音乐、QQ音乐、酷狗音乐、汽水音乐、Apple Music、Spotify、哔哩哔哩等平台不存在任何合作、授权、代理或从属关系，亦非各平台官方客户端。',
    '本軟體為獨立開發的第三方播放器，與網易雲音樂、QQ音樂、酷狗音樂、汽水音樂、Apple Music、Spotify、嗶哩嗶哩等平台不存在任何合作、授權、代理或從屬關係，亦非各平台官方客戶端。',
    'This software is an independently developed third-party player and has no cooperation, authorization, agency, or affiliation with platforms such as NetEase Cloud Music, QQ Music, Kugou, Soda Music, Apple Music, Spotify, and Bilibili. It is not an official client of any platform.',
    '本ソフトウェアは独立して開発されたサードパーティ製プレイヤーであり、NetEase Cloud Music、QQ音楽、KuGou、汽水音楽、Apple Music、Spotify、Bilibili などのプラットフォームとは一切の提携・許諾・代理・従属関係がなく、各プラットフォームの公式クライアントでもありません。',
    '본 소프트웨어는 독자적으로 개발된 서드파티 플레이어로, NetEase Cloud Music, QQ뮤직, 쿠거우, 치수이뮤직, Apple Music, Spotify, 빌리빌리 등 플랫폼과 어떠한 협력·승인·대리·종속 관계도 없으며 공식 클라이언트가 아닙니다.',
  ),
  disclaimerItem2: zh(
    '通过 Cookie / Token 登录并调用平台非官方接口，可能违反各平台用户协议（网易云《服务条款》8.5、QQ音乐《服务许可协议》5.1.1、酷狗《用户服务协议》5.1.9、汽水音乐《用户服务协议》5.1、哔哩哔哩《用户协议》等），可能导致账号风控、功能受限或账号封禁。',
    '透過 Cookie / Token 登入並呼叫平台非官方介面，可能違反各平台使用者協議（網易雲《服務條款》8.5、QQ音樂《服務許可協議》5.1.1、酷狗《使用者服務協議》5.1.9、汽水音樂《使用者服務協議》5.1、嗶哩嗶哩《使用者協議》等），可能導致帳號風控、功能受限或帳號封禁。',
    'Logging in with Cookie / Token and calling unofficial platform interfaces may violate each platform\'s user agreement (e.g., NetEase Cloud Music Terms of Service §8.5, QQ Music Service License Agreement §5.1.1, Kugou User Service Agreement §5.1.9, Soda Music User Service Agreement §5.1, Bilibili User Agreement), which may lead to account risk control, feature restrictions, or account bans.',
    'Cookie / Token によるログインや非公式インターフェースの呼び出しは、各プラットフォームの利用規約（NetEase Cloud Music サービス規約 8.5、QQ音楽 サービス許諾契約 5.1.1、KuGou ユーザーサービス契約 5.1.9、汽水音楽 ユーザーサービス契約 5.1、Bilibili 利用規約など）に違反する可能性があり、アカウントの風控、機能制限、アカウント停止につながる可能性があります。',
    'Cookie/Token으로 로그인하고 비공식 인터페이스를 호출하면 각 플랫폼의 이용약관(NetEase Cloud Music 서비스 약관 8.5, QQ뮤직 서비스 허가 계약 5.1.1, 쿠거우 사용자 서비스 약관 5.1.9, 치수이뮤직 사용자 서비스 약관 5.1, 빌리빌리 이용약관 등)을 위반할 수 있으며, 계정 리스크 관리, 기능 제한 또는 계정 차단으로 이어질 수 있습니다.',
  ),
  disclaimerItem3: zh(
    '因使用本软件登录、播放或管理内容而产生的一切账号风险与纠纷，均由您自行与相关平台解决，开发者不承担任何责任。',
    '因使用本軟體登入、播放或管理內容而產生的一切帳號風險與糾紛，均由您自行與相關平台解決，開發者不承擔任何責任。',
    'All account risks and disputes arising from logging in, playing, or managing content with this software shall be resolved by you directly with the relevant platforms. The developer assumes no responsibility.',
    '本ソフトウェアでのログイン・再生・コンテンツ管理によって生じる一切のアカウントリスクと紛争は、お客様と関連プラットフォームとの間で解決していただき、開発者は一切の責任を負いません。',
    '본 소프트웨어를 사용하여 로그인, 재생 또는 콘텐츠 관리 과정에서 발생하는 모든 계정 리스크와 분쟁은 사용자 본인이 해당 플랫폼과 해결해야 하며, 개발자는 어떠한 책임도 지지 않습니다.',
  ),
  disclaimerItem4: zh(
    '本软件没有任何自建服务器，不会上传、存储或泄露您的任何个人数据；登录凭证与缓存仅保存在您的本机（明文存储），不会向任何平台、第三方机构或个人传输、披露或出售。',
    '本軟體沒有任何自建伺服器，不會上傳、儲存或洩漏您的任何個人資料；登入憑證與快取僅保存在您的本機（明文儲存），不會向任何平台、第三方機構或個人傳輸、揭露或出售。',
    'This software has no self-hosted servers and will never upload, store, or leak any of your personal data. Login credentials and cache are stored only on your device (in plain text) and are never transmitted, disclosed, or sold to any platform, third party, or individual.',
    '本ソフトウェアは自社サーバーを持たず、個人データをアップロード・保存・漏えいすることはありません。ログイン情報とキャッシュは端末内にのみ保存され（平文）、いかなるプラットフォーム・第三者・個人にも送信・開示・販売されません。',
    '본 소프트웨어는 자체 서버가 없으며, 개인 데이터를 업로드·저장·유출하지 않습니다. 로그인 정보와 캐시는 기기 내에만 저장되고(평문), 어떤 플랫폼·제3자 기관·개인에게도 전송·공개·판매되지 않습니다.',
  ),
  disclaimerItem5: zh(
    '您可随时清除本地缓存、删除设备识别码与测试码（该操作不可逆）。',
    '您可隨時清除本機快取、刪除裝置識別碼與測試碼（該操作不可復原）。',
    'You can clear the local cache, delete the device ID and test codes at any time (this action is irreversible).',
    'ローカルキャッシュの削除、デバイス識別子とテストコードの削除はいつでも可能です（この操作は元に戻せません）。',
    '로컬 캐시 삭제, 기기 식별자와 테스트 코드 삭제는 언제든 가능합니다(이 작업은 되돌릴 수 없습니다).',
  ),
  disclaimerItem6: zh(
    '软件仅与各官方平台建立必要连接以提供功能，除此之外不进行任何其他连接。',
    '軟體僅與各官方平台建立必要連線以提供功能，除此之外不進行任何其他連線。',
    'The software only establishes the necessary connections with official platforms to provide its features and makes no other connections.',
    '本ソフトウェアは機能提供に必要な公式プラットフォームとの接続のみ行い、それ以外の接続は一切行いません。',
    '본 소프트웨어는 기능 제공에 필요한 공식 플랫폼 연결만 수행하며 그 외의 연결은 하지 않습니다.',
  ),
  disclaimerItem7: zh(
    '本软件所试听、展示的音乐、歌词、封面、MV 等内容的版权归相应平台及权利人所有，仅供个人非商业性试听与欣赏。',
    '本軟體所試聽、展示的音樂、歌詞、封面、MV 等內容的版權歸相應平台及權利人所有，僅供個人非商業性試聽與欣賞。',
    'The copyright of the music, lyrics, covers, MVs, and other content played or displayed by this software belongs to the respective platforms and rights holders, and is provided for personal, non-commercial listening and appreciation only.',
    '本ソフトウェアで視聴・表示される音楽、歌詞、ジャケット、MV などの著作権は各プラットフォームと権利者に帰属し、個人の非営利目的での視聴・鑑賞のみに提供されます。',
    '본 소프트웨어에서 감상·표시되는 음악, 가사, 커버, MV 등의 저작권은 해당 플랫폼과 권리자에게 있으며, 개인의 비상업적 감상 목적으로만 제공됩니다.',
  ),
  disclaimerItem8: zh(
    '严禁下载、复制、转存、再分发或商用任何受版权保护的内容；请勿长期保存、转存或再分发通过本软件试听的任何内容。',
    '嚴禁下載、複製、轉存、再分發或商用任何受版權保護的內容；請勿長期保存、轉存或再分發透過本軟體試聽的任何內容。',
    'Downloading, copying, transferring, redistributing, or commercially using any copyrighted content is strictly prohibited. Please do not store, transfer, or redistribute any content you listen to through this software.',
    '著作権で保護されたコンテンツのダウンロード・複製・転送・再配布・商用利用は固く禁じられています。本ソフトウェアで視聴した内容を長期保存・転送・再配布しないでください。',
    '저작권으로 보호된 콘텐츠의 다운로드·복제·전송·재배포·상업적 이용은 엄격히 금지됩니다. 본 소프트웨어로 감상한 콘텐츠를 장기 보관·전송·재배포하지 마세요.',
  ),
  disclaimerItem9: zh(
    'WAV 离线导出仅限个人学习、研究、音效调试；导出的音频若被上传、传播、分发或商用，系您的个人操作，责任由您自行承担（本软件已通过醒目弹窗与倒计时提示告知）。',
    'WAV 離線匯出僅限個人學習、研究、音效調試；匯出的音訊若被上傳、傳播、分發或商用，係您的個人操作，責任由您自行承擔（本軟體已透過醒目彈窗與倒數計時提示告知）。',
    'WAV offline export is limited to personal study, research, and audio tuning. If exported audio is uploaded, distributed, or used commercially, that is your own action, and you bear full responsibility (the software has already informed you via prominent pop-ups and countdown notices).',
    'WAV オフライン書き出しは個人の学習・研究・音響調整のみに限定されます。書き出した音声がアップロード・配布・商用利用された場合、それはお客様ご自身の行為であり、責任はお客様が負います（本ソフトウェアは目立つポップアップとカウントダウンで事前に告知しています）。',
    'WAV 오프라인 내보내기는 개인 학습·연구·음향 조정 용도로만 제한됩니다. 내보낸 오디오가 업로드·배포·상업적으로 사용될 경우 이는 사용자 본인의 행동이며 책임은 본인이 부담합니다(본 소프트웨어는 눈에 띄는 팝업과 카운트다운으로 사전에 안내했습니다).',
  ),
  disclaimerItem10: zh(
    '灰色歌曲跨平台补全等音源匹配功能仅用于补全免费但受版权或地区影响的歌曲，不绕过 VIP、付费专辑等平台付费权限。',
    '灰色歌曲跨平台補全等音源匹配功能僅用於補全免費但受版權或地區影響的歌曲，不繞過 VIP、付費專輯等平台付費權限。',
    'Cross-platform source matching features such as gray-song completion are only used to fill in free songs affected by copyright or region, and do not bypass VIP, paid-album, or other paid permissions of the platforms.',
    '灰色曲のクロスプラットフォーム補完などの音源マッチング機能は、著作権や地域の影響で再生できない無料楽曲の補完にのみ使用され、VIP や有料アルバムなどの有料権限を迂回することはありません。',
    '그레이송 크로스플랫폼 보완 등 음원 매칭 기능은 저작권 또는 지역 제한이 있는 무료 곡을 보완하는 용도로만 사용되며, VIP·유료 앨범 등 플랫폼의 유료 권한을 우회하지 않습니다.',
  ),
  disclaimerItem11: zh(
    '禁止使用自动化程序、脚本、爬虫等方式批量抓取、采集各平台的内容与数据（包括歌曲、歌单、评论、用户信息）。',
    '禁止使用自動化程式、腳本、爬蟲等方式批次抓取、採集各平台的內容與資料（包括歌曲、歌單、評論、使用者資訊）。',
    'It is prohibited to use automated programs, scripts, crawlers, or similar means to batch-scrape or harvest content and data from any platform (including songs, playlists, comments, and user information).',
    '自動化プログラム・スクリプト・クローラーなどによる各プラットフォームのコンテンツとデータ（楽曲・プレイリスト・コメント・ユーザー情報を含む）の一括取得は禁止されています。',
    '자동화 프로그램, 스크립트, 크롤러 등을 이용하여 각 플랫폼의 콘텐츠와 데이터(곡, 플레이리스트, 댓글, 사용자 정보 포함)를 대량으로 수집하는 행위는 금지됩니다.',
  ),
  disclaimerItem12: zh(
    '禁止对本软件进行反向工程、破解、提取源代码或移除技术保护措施。',
    '禁止對本軟體進行反向工程、破解、提取原始碼或移除技術保護措施。',
    'Reverse engineering, cracking, extracting the source code, or removing technical protection measures from this software is prohibited.',
    '本ソフトウェアのリバースエンジニアリング、クラック、ソースコードの抽出、技術的保護手段の除去は禁止されています。',
    '본 소프트웨어에 대한 역공학, 크랙, 소스코드 추출 또는 기술적 보호 조치 제거는 금지됩니다.',
  ),
  disclaimerItem13: zh(
    '本软件仅限个人非商业使用；以转售、出借、出租、再分发等方式用于商业或营利目的均被禁止。',
    '本軟體僅限個人非商業使用；以轉售、出借、出租、再分發等方式用於商業或營利目的均被禁止。',
    'This software is for personal, non-commercial use only. Any resale, lending, renting, redistribution, or use for commercial or profit-making purposes is prohibited.',
    '本ソフトウェアは個人の非営利目的の使用に限られます。転売・貸与・レンタル・再配布などの商業・営利目的での使用は禁止されています。',
    '본 소프트웨어는 개인의 비상업적 사용으로만 제한되며, 재판매·대여·임대·재배포 등 상업적 또는 영리 목적의 사용은 금지됩니다.',
  ),
  disclaimerItem14: zh(
    '为提供智能混音与无缝衔接功能，本软件会将播放中的音频临时缓存到本机用于分析，并按 30 天未使用、超过容量上限或主动清除等规则自动删除。',
    '為提供智慧混音與無縫銜接功能，本軟體會將播放中的音訊暫時快取到本機用於分析，並按 30 天未使用、超過容量上限或主動清除等規則自動刪除。',
    'To provide smart mixing and gapless transition features, this software temporarily caches the audio being played on your device for analysis, and automatically deletes it when unused for 30 days, over the capacity limit, or upon your manual clearing.',
    'スマートミキシングとシームレス接続機能を提供するため、本ソフトウェアは再生中の音声を分析用に端末へ一時キャッシュし、30日間未使用・容量上限超過・手動クリアなどの規則で自動削除します。',
    '스마트 믹싱과 무끊김 전환 기능을 제공하기 위해 본 소프트웨어는 재생 중인 오디오를 분석용으로 기기에 임시 캐시하며, 30일 미사용·용량 상한 초과·수동 삭제 등의 규칙에 따라 자동 삭제합니다.',
  ),
  disclaimerItem15: zh(
    '以上为要点摘要，完整条款请阅读 设置 → 关于 → 法律声明/用户协议。',
    '以上為要點摘要，完整條款請閱讀 設定 → 關於 → 法律聲明/使用者協議。',
    'The above is a summary. For the full terms, please read Settings → About → Legal Notice / User Agreement.',
    '上記は要点の要約です。完全な規約は 設定 → 情報 → 法的通知/利用規約 をご覧ください。',
    '위 내용은 핵심 요약입니다. 전체 약관은 설정 → 정보 → 법적 고지/이용약관에서 확인하세요.',
  ),
  disclaimerHint: zh(
    '⚠ 完整条款请阅读 设置 → 关于 →',
    '⚠ 完整條款請閱讀 設定 → 關於 →',
    '⚠ For full terms, please read Settings → About →',
    '⚠ 完全な規約は 設定 → 情報 →',
    '⚠ 전체 약관은 설정 → 정보 →',
  ),
  legalLink: zh(
    '法律声明/用户协议',
    '法律聲明/使用者協議',
    'Legal Notice / User Agreement',
    '法的通知/利用規約',
    '법적 고지/이용약관',
  ),
  exit: zh('退出', '退出', 'Exit', '終了', '종료'),
  agreeTpl: zh('同意（{n}）', '同意（{n}）', 'Agree ({n})', '同意（{n}）', '동의({n})'),
  readingHint: zh(
    '请阅读以上声明…',
    '請閱讀以上聲明…',
    'Please read the above statements…',
    '上記の声明をお読みください…',
    '위의 내용을 읽어 주세요…',
  ),
  finalTitle: zh(
    '我们需要您的最终确认',
    '我們需要您的最終確認',
    'We need your final confirmation',
    '最終確認をお願いします',
    '최종 확인이 필요합니다',
  ),
  finalP1: zh(
    '您在本软件中的所有操作——登录各音乐平台、搜索、播放、歌单管理、音效处理与导出等——均为您本人主动发起并完成的操作。',
    '您在本軟體中的所有操作——登入各音樂平台、搜尋、播放、歌單管理、音效處理與匯出等——均為您本人主動發起並完成的操作。',
    'All your operations in this software — logging into music platforms, searching, playing, managing playlists, audio processing, exporting, and more — are actions initiated and completed by you personally.',
    '本ソフトウェアでのすべての操作（音楽プラットフォームへのログイン、検索、再生、プレイリスト管理、音声処理、書き出しなど）は、すべてお客様ご自身が自発的に開始し完了した操作です。',
    '본 소프트웨어에서의 모든 작업(음악 플랫폼 로그인, 검색, 재생, 플레이리스트 관리, 음향 처리, 내보내기 등)은 모두 사용자 본인이 스스로 시작하고 완료한 작업입니다.',
  ),
  finalP2: zh(
    '由此产生的对各平台接口的访问及全部结果，均视为用户操作而非开发者行为；开发者不对因您的操作引发的平台处罚、账号封禁或任何法律后果承担责任。',
    '由此產生的對各平台介面的存取及全部結果，均視為使用者操作而非開發者行為；開發者不對因您的操作引發的平台處罰、帳號封禁或任何法律後果承擔責任。',
    'The resulting access to platform interfaces and all outcomes are considered user operations, not developer actions. The developer assumes no responsibility for platform penalties, account bans, or any legal consequences caused by your operations.',
    'その結果生じる各プラットフォームのインターフェースへのアクセスとすべての結果は、開発者の行為ではなくユーザー操作とみなされます。開発者は、お客様の操作によって生じたプラットフォームからの処罰、アカウント停止、その他いかなる法的結果についても責任を負いません。',
    '그로 인해 발생하는 각 플랫폼 인터페이스 접근과 모든 결과는 개발자의 행위가 아닌 사용자 작업으로 간주되며, 개발자는 사용자의 작업으로 인한 플랫폼 제재, 계정 차단 또는 어떠한 법적 결과에 대해서도 책임을 지지 않습니다.',
  ),
  finalP3: zh(
    '您已确认阅读并同意《法律声明与用户协议》，完整条款可随时在 设置 → 关于 → 法律声明/用户协议 中查阅。',
    '您已確認閱讀並同意《法律聲明與使用者協議》，完整條款可隨時在 設定 → 關於 → 法律聲明/使用者協議 中查閱。',
    'You have confirmed that you have read and agree to the Legal Notice & User Agreement. The full terms can be reviewed at any time in Settings → About → Legal Notice / User Agreement.',
    'あなたは「法的通知と利用規約」を読み、同意したことを確認しました。完全な規約は 設定 → 情報 → 法的通知/利用規約 からいつでも確認できます。',
    '귀하는 법적 고지 및 이용약관을 읽고 동의했음을 확인했습니다. 전체 약관은 설정 → 정보 → 법적 고지/이용약관에서 언제든 확인할 수 있습니다.',
  ),
  finalP4: zh(
    '本软件为通用型音乐播放工具，本身不包含、不存储、不提供任何音乐内容，您播放的内容均来自各平台依您的账号授权提供；所有平台接口访问均由您本人操作触发，软件不提供任何自动化、批量抓取服务，亦不运营相关服务器或代理。软件的主要功能——使用您本人账号在授权范围内试听音乐——具有合法且主要的用途；若您将其用于违反平台条款或法律法规的用途，该等选择与后果由您本人承担。',
    '本軟體為通用型音樂播放工具，本身不包含、不儲存、不提供任何音樂內容，您播放的內容均來自各平台依您的帳號授權提供；所有平台介面存取均由您本人操作觸發，軟體不提供任何自動化、批次抓取服務，亦不營運相關伺服器或代理。軟體的主要功能——使用您本人帳號在授權範圍內試聽音樂——具有合法且主要的用途；若您將其用於違反平台條款或法律法規的用途，該等選擇與後果由您本人承擔。',
    'This software is a general-purpose music player. It does not contain, store, or provide any music content itself — the content you play is provided by the platforms under your own account authorization. All platform interface access is triggered by your own actions, and the software provides no automated or batch-scraping services and operates no related servers or proxies. The primary function of the software — listening to music within the scope of your account authorization — has a legitimate and substantial purpose. If you use it for purposes that violate platform terms or laws, such choices and consequences are yours alone.',
    '本ソフトウェアは汎用の音楽再生ツールであり、音楽コンテンツ自体を内蔵・保存・提供するものではなく、再生されるコンテンツは各プラットフォームがお客様のアカウントの許諾に基づき提供するものです。すべてのプラットフォームインターフェースへのアクセスはお客様ご自身の操作によって発生し、本ソフトウェアは自動化・一括取得サービスを提供せず、関連サーバーやプロキシも運営しません。本ソフトウェアの主要機能（ご自身のアカウントの許諾範囲内での試聴）は合法的かつ主要な用途を有します。プラットフォーム規約や法令に違反する用途に使用した場合、その選択と結果はお客様ご自身が負うものとします。',
    '본 소프트웨어는 범용 음악 재생 도구로서, 음악 콘텐츠 자체를 포함·저장·제공하지 않으며, 재생되는 콘텐츠는 각 플랫폼이 사용자 본인 계정의 승인에 따라 제공합니다. 모든 플랫폼 인터페이스 접근은 사용자 본인의 조작으로 발생하며, 본 소프트웨어는 자동화·대량 수집 서비스를 제공하지 않고 관련 서버나 프록시도 운영하지 않습니다. 본 소프트웨어의 주요 기능(본인 계정의 승인 범위 내 감상)은 합법적이고 주된 용도를 지닙니다. 플랫폼 약관이나 법률·규정에 위반되는 용도로 사용할 경우, 그 선택과 결과는 사용자 본인이 부담합니다.',
  ),
  welcomeLine: zh(
    '欢迎您使用',
    '歡迎您使用',
    'Welcome',
    'ご利用ありがとうございます',
    '이용해 주셔서 환영합니다',
  ),
  welcomeEnter: zh('进入', '進入', 'Enter', 'はじめる', '시작'),
  legalModalTitle: zh(
    '法律声明与用户协议',
    '法律聲明與使用者協議',
    'Legal Notice & User Agreement',
    '法的通知と利用規約',
    '법적 고지 및 이용약관',
  ),
  legalModalClose: zh(
    '我已了解',
    '我已了解',
    'I understand',
    '了解しました',
    '확인했습니다',
  ),
  ariaClose: zh('关闭', '關閉', 'Close', '閉じる', '닫기'),
}
