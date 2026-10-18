const languages = [
  { code: 'en', name: 'English', search: 'english 영어 英語 英语' },
  { code: 'ko', name: '한국어', search: 'korean 한국어 韓国語 韩语' },
  { code: 'ja', name: '日本語', search: 'japanese 일본어 日本語 日语' },
  { code: 'zh-CN', name: '简体中文', search: 'chinese 중국어 中国語 中文 简体中文' },
];
const copy = {
  ko: {
    skip:'본문으로 이동',navFeatures:'주요 기능',navWorkflow:'사용 방법',languageSearch:'언어 검색',noLanguage:'검색 결과가 없습니다',eyebrow:'프로젝트의 모든 작업을 한곳에서',heroOne:'리뷰부터',heroTwo:'작업 완료까지.',heroDescription:"검토 화면과 대화, 후속 작업을 함께 관리합니다. 프로젝트 리뷰와 Codex 작업을 컴퓨터에 저장하는 데스크톱 앱입니다.",download:'macOS용 다운로드',viewSource:'소스 코드 보기 ↗',downloadNote:"macOS 13 이상 · Apple Silicon 및 Intel · Windows 10/11 x64 · MIT 라이선스",noteText:'화면 이동은 줄이고,\n작업 내용은 함께.',noteFoot:'리뷰하는 흐름에 맞춘 작업 공간.',previewLabel:'검토 화면과 작업 내용을 함께 관리',previewAlt:'샘플 데이터로 구성한 ReviewOps 화면. 프로젝트 목록, 웹사이트 뷰어, 스크린샷이 첨부된 리뷰 대화와 Codex 작업을 보여 줍니다.',previewCaption:"샘플 데이터로 구성한 화면 예시입니다. 프로젝트와 리뷰 자료는 컴퓨터에 저장합니다.",principleOne:'ReviewOps 계정 없이 사용',principleTwo:'로컬 폴더 또는 SSH 호스트 연결',principleThree:'수정하고 확장할 수 있는 오픈소스',featuresEyebrow:'리뷰에 필요한 기능을 한곳에',featuresTitle:'다음 작업에 필요한 내용을 함께.',featuresDescription:'첫 스크린샷부터 마지막 변경 사항까지, 리뷰에 필요한 내용을 한곳에서 이어 갑니다.',featureOneTitle:'리뷰를 프로젝트에 모읍니다.',featureOneText:'그룹 안에서 프로젝트를 관리합니다. 리뷰의 대화와 우선순위, 진행 상태를 함께 살펴봅니다.',featureTwoTitle:'검토할 내용을 직접 보여 줍니다.',featureTwoText:'리뷰 옆에서 웹사이트를 열고 데스크톱·태블릿·모바일 크기로 확인합니다. 스크린샷, 브라우저 로그, 파일은 본문과 분리된 첨부 버튼으로 표시합니다. 버튼을 누르면 팝업에서 내용을 볼 수 있습니다.',featureThreeTitle:'리뷰 내용을 작업으로 연결합니다.',featureThreeText:"컴퓨터나 SSH 서버의 Codex CLI에 지시와 첨부 자료를 전달합니다. 리뷰에서 작업 응답을 함께 확인합니다.",featureFourTitle:'한 번 등록한 연결을 다시 씁니다.',featureFourText:'사이드 메뉴에서 SSH 호스트와 Codex 계정을 관리합니다. 프로젝트를 연결할 때 저장된 호스트를 선택합니다.',featureFiveTitle:'익숙한 언어로 사용합니다.',featureFiveText:'설정에서 화면 언어를 선택합니다. 항목이 많은 드롭다운은 검색하고 키보드로 선택할 수 있습니다.',featureSixTitle:'자료를 직접 보관합니다.',featureSixText:'리뷰는 로컬 SQLite와 파일에 저장합니다. 프로젝트를 백업하고 GitHub Releases에서 앱 업데이트를 받습니다.',workflowEyebrow:'처음 시작할 때',workflowTitle:'프로젝트를 연결하고,\n리뷰를 시작합니다.',workflowText:'프로젝트에서 시작해 결정한 내용과 파일, 후속 작업을 함께 관리합니다.',stepOneTitle:'프로젝트 연결',stepOneText:'그룹과 프로젝트를 만듭니다. 로컬 폴더나 저장된 SSH 호스트와 작업 폴더를 선택합니다.',stepTwoTitle:'리뷰 등록',stepTwoText:'웹사이트를 열고 변경할 내용을 작성합니다. 스크린샷, 로그, 파일을 함께 첨부합니다.',stepThreeTitle:'작업 진행',stepThreeText:'작업이력에 내용을 남기거나 Codex에 작업을 요청합니다. 결과는 원래 리뷰에서 이어서 관리합니다.',faqEyebrow:'시작 전 알아둘 내용',faqTitle:'사용에 필요한 안내.',faqOneQuestion:'ReviewOps 서버나 계정이 필요합니까?',faqOneAnswer:"ReviewOps 서버와 계정은 필요하지 않습니다. 리뷰와 첨부 자료는 컴퓨터에 저장합니다. 외부 웹사이트, SSH 연결, Codex, 업데이트 확인 기능을 사용할 때는 네트워크에 연결합니다.",faqTwoQuestion:'Codex 작업은 어떻게 실행합니까?',faqTwoAnswer:'선택한 로컬 폴더 또는 SSH 서버에서 Codex CLI를 직접 실행합니다. 해당 환경에 Codex를 설치하고 로그인해야 합니다. 작업은 해당 계정의 권한으로 실행하며 앱에서 별도의 샌드박스를 추가하지 않습니다.',faqThreeQuestion:"어떤 운영체제에서 사용할 수 있습니까?",faqThreeAnswer:"Apple Silicon 및 Intel Mac의 macOS 13 이상과 Intel 또는 AMD 프로세서를 사용하는 64비트 Windows 10·11을 지원합니다. 운영체제에 맞는 설치 파일을 선택하십시오.",faqFourQuestion:'업데이트는 어떻게 받습니까?',faqFourAnswer:"macOS에서는 새 버전이 있으면 사이드 메뉴 아래에 업데이트 알림이 표시됩니다. 알림을 누르면 다운로드와 파일 검사, 설치를 마치고 앱을 다시 시작합니다. 컴퓨터에서 실행 중인 작업과 파일 전송을 마치고 터미널을 닫은 뒤 설치하십시오. Windows에서는 이 페이지의 최신 설치 파일을 내려받아 실행하십시오.",faqFiveQuestion:'상업적으로 사용할 수 있습니까?',faqFiveAnswer:'ReviewOps 소스 코드는 MIT 라이선스로 제공합니다. 포함된 라이브러리, 글꼴, 아이콘은 각각의 라이선스를 유지하며 해당 내용은 저장소와 앱에 포함합니다.',downloadEyebrow:'작업을 시작할 준비',downloadTitle:'다음 리뷰를 시작하십시오.',downloadDescription:'ReviewOps를 설치하고 프로젝트를 연결하여 검토 화면과 대화를 함께 관리하십시오.',readGuide:'사용 안내 보기 ↗',footer:'SEASON과 기여자가 만듭니다. MIT 라이선스 오픈소스.',issues:'문제 제보',
    downloadWindows:"Windows용 다운로드",
    faqRemoteQuestion:"앱을 종료해도 SSH 작업이 계속됩니까?",
    faqRemoteAnswer:"ReviewOps 1.2.2 이상에서 Linux SSH 서버에 요청한 Codex 작업은 앱을 종료하거나 업데이트하는 동안에도 서버에서 계속 실행됩니다. 앱을 다시 시작하면 작업에 다시 연결하고 출력 내용을 불러옵니다. 터미널에 직접 입력한 명령에는 이 기능을 적용하지 않습니다.",
    faqInstallQuestion:"앱은 어떻게 설치합니까?",
    faqInstallAnswer:"Windows에서는 내려받은 .exe 파일을 실행하고 설치 안내를 따르십시오. 설치 파일에 디지털 서명이 없어 Windows에서 설치 경고를 표시할 수 있습니다. macOS에서는 .dmg 파일을 열고 ReviewOps를 응용 프로그램 폴더로 옮기십시오. macOS 앱에는 Apple 공증이 포함되어 있지 않습니다. 운영체제에서 실행 승인을 요청하면 설치 안내를 따르십시오.",
  },
  ja: {
    skip:'本文へ移動',navFeatures:'機能',navWorkflow:'使い方',languageSearch:'言語を検索',noLanguage:'一致する言語がありません',eyebrow:'プロジェクトの作業をひとつの場所に',heroOne:'レビューから、',heroTwo:'作業の完了まで。',heroDescription:"確認する画面、会話、次の作業をまとめて管理。プロジェクトのレビューとCodexタスクをパソコンに保存するデスクトップアプリです。",download:'macOS版をダウンロード',viewSource:'ソースコードを見る ↗',downloadNote:"macOS 13以降 · Apple Silicon / Intel · Windows 10/11 x64 · MITライセンス",noteText:'画面の切り替えを減らし、\n作業の流れを保つ。',noteFoot:'レビューの流れに沿った作業スペース。',previewLabel:'確認する画面と作業内容をまとめて管理',previewAlt:'サンプルデータを使ったReviewOps画面。プロジェクト一覧、ウェブビューアー、スクリーンショット付きのレビュー会話、Codexタスクを表示しています。',previewCaption:"サンプルデータを使った画面イメージです。プロジェクトとレビューのデータはパソコンに保存されます。",principleOne:'ReviewOpsアカウントは不要',principleTwo:'ローカルフォルダーまたはSSHホスト',principleThree:'自由に改良できるオープンソース',featuresEyebrow:'レビューに必要な機能をまとめて',featuresTitle:'次の作業に必要な情報を一緒に。',featuresDescription:'最初のスクリーンショットから最後の変更まで、レビューの内容をひとつの場所で引き継ぎます。',featureOneTitle:'レビューをプロジェクトにまとめる。',featureOneText:'グループ内でプロジェクトを管理。会話を残しながら、レビューの優先度と進行状況を追跡できます。',featureTwoTitle:'確認する内容をそのまま伝える。',featureTwoText:'レビューの隣でウェブサイトを開き、PC、タブレット、モバイルのサイズで確認できます。スクリーンショット、ブラウザーログ、ファイルは本文と分けた添付ボタンで表示します。ボタンを押すとポップアップで内容を確認できます。',featureThreeTitle:'レビューを次の作業へつなげる。',featureThreeText:"パソコンまたはSSHホストのCodex CLIに指示と添付資料を送信。レビューを見ながら応答を確認できます。",featureFourTitle:'登録した接続先を繰り返し使う。',featureFourText:'サイドバーでSSHホストとCodexアカウントを管理。プロジェクトの接続時に保存済みホストを選択します。',featureFiveTitle:'使い慣れた言語で操作する。',featureFiveText:'設定で表示言語を選択できます。項目の多いドロップダウンでは検索とキーボード操作を利用できます。',featureSixTitle:'データを自分で管理する。',featureSixText:'レビューはローカルのSQLiteとファイルに保存。プロジェクトのバックアップを書き出し、GitHub Releasesからアプリを更新できます。',workflowEyebrow:'はじめに',workflowTitle:'接続して、レビュー。\nそのまま作業へ。',workflowText:'プロジェクトを作成し、決定事項、ファイル、その後の作業をまとめて管理します。',stepOneTitle:'プロジェクトを接続',stepOneText:'グループとプロジェクトを作成。ローカルフォルダー、または保存済みSSHホストと作業フォルダーを選択します。',stepTwoTitle:'レビューを記録',stepTwoText:'ウェブサイトを開いて変更内容を記入し、スクリーンショット、ログ、ファイルを添付します。',stepThreeTitle:'作業を進める',stepThreeText:'作業履歴に内容を記録するか、Codexに依頼。結果は元のレビューと一緒に管理できます。',faqEyebrow:'利用前に',faqTitle:'知っておきたいこと。',faqOneQuestion:'サーバーやReviewOpsアカウントは必要ですか？',faqOneAnswer:"ReviewOpsのサーバーやアカウントは不要です。レビューと添付資料はパソコンに保存します。外部サイト、SSH接続、Codex、更新確認を使う際はネットワークに接続します。",faqTwoQuestion:'Codexタスクはどのように実行されますか？',faqTwoAnswer:'選択したローカルフォルダーまたはSSHホスト上でCodex CLIを直接実行します。先にその環境でCodexをインストールしてログインしてください。処理はそのアカウントの権限で実行し、アプリ独自のサンドボックスは追加しません。',faqThreeQuestion:"対応するOSは？",faqThreeAnswer:"Apple SiliconおよびIntel MacのmacOS 13以降と、IntelまたはAMDプロセッサーの64ビット版Windows 10・11に対応します。OSに合ったインストーラーを選択してください。",faqFourQuestion:'更新はどのように行いますか？',faqFourAnswer:"macOSでは、新しいバージョンがあるとサイドバーの下部に更新通知が表示されます。通知を選択すると、ダウンロード、ファイルの検証、インストールを行い、アプリを再起動します。ローカルの作業とファイル転送を完了し、ターミナルを閉じてからインストールしてください。Windowsでは、このページから最新のインストーラーをダウンロードして実行してください。",faqFiveQuestion:'商用利用できますか？',faqFiveAnswer:'ReviewOpsのソースコードはMITライセンスで提供します。同梱ライブラリー、フォント、アイコンにはそれぞれのライセンスが適用され、リポジトリとアプリに記載されています。',downloadEyebrow:'次の作業をはじめる',downloadTitle:'次のレビューを始める。',downloadDescription:'ReviewOpsをダウンロードし、プロジェクトを接続。レビュー画面と会話を一緒に管理できます。',readGuide:'利用ガイドを読む ↗',footer:'SEASONとコントリビューターが開発。MITライセンスのオープンソース。',issues:'問題を報告',
    downloadWindows:"Windows版をダウンロード",
    faqRemoteQuestion:"アプリを閉じてもSSHの作業は続きますか？",
    faqRemoteAnswer:"ReviewOps 1.2.2以降でLinuxのSSHホスト上に開始したCodexタスクは、アプリの終了中や更新中もサーバー上で続きます。アプリを再起動するとタスクに再接続し、出力を取得します。ターミナルに直接入力したコマンドには、この機能は適用されません。",
    faqInstallQuestion:"インストール方法は？",
    faqInstallAnswer:"Windowsではダウンロードした.exeファイルを開き、インストーラーの案内に従ってください。インストーラーにはデジタル署名がないため、Windowsに警告が表示される場合があります。macOSでは.dmgファイルを開き、ReviewOpsをアプリケーションフォルダーに移動してください。macOSアプリにはAppleの公証が含まれていません。OSが起動の承認を求める場合は、インストールガイドに従ってください。",
  },
  'zh-CN': {
    skip:'跳转到正文',navFeatures:'功能',navWorkflow:'使用方法',languageSearch:'搜索语言',noLanguage:'没有匹配的语言',eyebrow:'在一个地方管理项目工作',heroOne:'从审查开始，',heroTwo:'到工作完成。',heroDescription:"将页面、讨论和后续工作放在一起。在电脑上保存项目审查与 Codex 任务的桌面工作空间。",download:'下载 macOS 版',viewSource:'查看源代码 ↗',downloadNote:"macOS 13 及以上 · Apple Silicon 与 Intel · Windows 10/11 x64 · MIT 许可证",noteText:'减少页面切换，\n保留完整上下文。',noteFoot:'围绕审查流程设计的工作空间。',previewLabel:'将审查页面和工作内容放在一起',previewAlt:'使用示例数据绘制的 ReviewOps 界面，展示项目列表、网站查看器、附带截图的审查讨论和 Codex 任务。',previewCaption:"使用示例数据绘制的界面示意图。项目和审查数据保存在您的电脑上。",principleOne:'无需 ReviewOps 账户',principleTwo:'连接本地文件夹或 SSH 主机',principleThree:'开源，可自由修改和扩展',featuresEyebrow:'完整的审查工作空间',featuresTitle:'下一步需要的内容，都在一起。',featuresDescription:'从第一张截图到最后一次修改，让审查所需的信息始终保存在同一个地方。',featureOneTitle:'为每条审查找到归属。',featureOneText:'在分组中管理项目。保留讨论内容，同时跟踪审查、优先级和进度。',featureTwoTitle:'直接展示需要审查的内容。',featureTwoText:'在审查旁边打开网站，查看桌面、平板和手机尺寸的页面。截图、浏览器日志和文件通过独立于正文的附件按钮显示。点击按钮即可在弹出窗口中查看内容。',featureThreeTitle:'把审查内容变成任务。',featureThreeText:"向电脑或 SSH 主机上的 Codex CLI 发送指令与附件，在原审查中跟踪响应。",featureFourTitle:'连接一次，重复使用。',featureFourText:'在侧边栏管理 SSH 主机和 Codex 账户。连接项目时，选择已保存的主机即可。',featureFiveTitle:'使用熟悉的语言。',featureFiveText:'在设置中选择界面语言。较长的下拉列表支持搜索，也可以使用键盘选择。',featureSixTitle:'由您保管自己的数据。',featureSixText:'审查保存在本地 SQLite 和文件中。导出项目备份，并通过 GitHub Releases 获取应用更新。',workflowEyebrow:'从第一次打开开始',workflowTitle:'连接项目，开始审查，\n继续完成工作。',workflowText:'从项目开始，将决定、文件和后续工作一起管理。',stepOneTitle:'连接项目',stepOneText:'创建分组与项目。选择本地文件夹，或已保存的 SSH 主机和工作目录。',stepTwoTitle:'记录审查内容',stepTwoText:'打开网站，写下需要修改的内容，并附加截图、日志或文件。',stepThreeTitle:'继续处理',stepThreeText:'在工作记录中讨论修改，或向 Codex 发送任务。将结果保留在原来的审查中。',faqEyebrow:'开始之前',faqTitle:'需要了解的信息。',faqOneQuestion:'需要服务器或 ReviewOps 账户吗？',faqOneAnswer:"不需要 ReviewOps 服务器或账户。审查与附件保存在您的电脑上。使用外部网站、SSH 连接、Codex 或检查更新时需要网络连接。",faqTwoQuestion:'Codex 任务如何运行？',faqTwoAnswer:'ReviewOps 在选定的本地文件夹中或直接在 SSH 主机上运行 Codex CLI。请先在对应环境安装 Codex 并登录。任务使用该账户的权限运行，应用不会额外添加沙箱。',faqThreeQuestion:"支持哪些操作系统？",faqThreeAnswer:"支持 Apple Silicon 和 Intel Mac 上的 macOS 13 及以上版本，以及使用 Intel 或 AMD 处理器的 64 位 Windows 10 和 11。请选择适合您操作系统的安装包。",faqFourQuestion:'如何更新？',faqFourAnswer:"在 macOS 上，有新版本时，侧边栏底部会显示更新通知。点击通知后，应用会下载、验证文件、安装并重新启动。安装前，请完成本地任务和文件传输并关闭终端。在 Windows 上，请从此页面下载最新安装包并运行。",faqFiveQuestion:'可以商用吗？',faqFiveAnswer:'ReviewOps 源代码使用 MIT 许可证。随附的依赖、字体和图标保留各自的许可证，相关内容包含在仓库和应用中。',downloadEyebrow:'准备开始下一项工作',downloadTitle:'从这里开始下一次审查。',downloadDescription:'下载 ReviewOps，连接项目，将审查页面与讨论内容放在一起。',readGuide:'阅读使用指南 ↗',footer:'由 SEASON 和贡献者开发。基于 MIT 许可证开源。',issues:'报告问题',
    downloadWindows:"下载 Windows 版",
    faqRemoteQuestion:"关闭应用后，SSH 任务会继续吗？",
    faqRemoteAnswer:"通过 ReviewOps 1.2.2 及以上版本在 Linux SSH 主机上启动的 Codex 任务，会在应用关闭或更新期间继续在服务器上运行。应用重新启动后会重新连接任务并获取输出。在终端中直接输入的命令不使用此功能。",
    faqInstallQuestion:"如何安装应用？",
    faqInstallAnswer:"在 Windows 上，打开下载的 .exe 文件并按照安装程序的提示操作。安装包没有数字签名，因此 Windows 可能显示安装警告。在 macOS 上，打开 .dmg 文件并将 ReviewOps 移到“应用程序”文件夹。macOS 应用未经 Apple 公证。如果操作系统要求批准打开应用，请按照安装指南操作。",
  },
};
const english = {};
document.querySelectorAll('[data-i18n]').forEach(element => {
  const clone = element.cloneNode(true);
  clone.querySelectorAll('br').forEach(lineBreak => lineBreak.replaceWith('\n'));
  english[element.dataset.i18n] = clone.textContent;
});
document.querySelectorAll('[data-i18n-alt]').forEach(element => { english[element.dataset.i18nAlt] = element.alt; });
english.languageSearch = 'Search languages';
copy.en = english;
const trigger = document.querySelector('#language-trigger');
const popup = document.querySelector('#language-popup');
const search = document.querySelector('#language-search');
const options = document.querySelector('#language-options');
let current = 'en';

function applyLanguage(code) {
  current = languages.some(language => language.code === code) ? code : 'en';
  const text = copy[current];
  document.documentElement.lang = current;
  document.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = text[element.dataset.i18n] || english[element.dataset.i18n];
    if (element.textContent.includes('\n')) element.style.whiteSpace = 'pre-line';
  });
  document.querySelectorAll('[data-i18n-alt]').forEach(element => { element.alt = text[element.dataset.i18nAlt] || english[element.dataset.i18nAlt]; });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(element => { element.placeholder = text[element.dataset.i18nPlaceholder] || english[element.dataset.i18nPlaceholder]; });
  document.querySelector('#language-current').textContent = languages.find(language => language.code === current).name;
  trigger.setAttribute('aria-label', `${text.languageSearch}: ${languages.find(language => language.code === current).name}`);
  try { localStorage.setItem('reviewops-site-language', current); } catch { /* The site also works without storage. */ }
  renderLanguages();
}
function renderLanguages() {
  const query = search.value.trim().toLocaleLowerCase();
  options.replaceChildren();
  const matches = languages.filter(language => `${language.name} ${language.code} ${language.search}`.toLocaleLowerCase().includes(query));
  for (const language of matches) {
    const button = document.createElement('button');
    button.type = 'button'; button.role = 'option'; button.lang = language.code;
    button.setAttribute('aria-selected', String(language.code === current));
    button.textContent = language.name;
    if (language.code === current) { const check = document.createElement('span'); check.textContent = '✓'; check.ariaHidden = 'true'; button.append(check); }
    button.addEventListener('click', () => { applyLanguage(language.code); closeLanguages(true); });
    options.append(button);
  }
  document.querySelector('#language-empty').hidden = matches.length > 0;
}
function closeLanguages(restoreFocus = false) { popup.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (restoreFocus) trigger.focus(); }
function openLanguages() { popup.hidden = false; trigger.setAttribute('aria-expanded', 'true'); search.value = ''; renderLanguages(); search.focus(); }
trigger.addEventListener('click', () => popup.hidden ? openLanguages() : closeLanguages(true));
search.addEventListener('input', renderLanguages);
document.addEventListener('pointerdown', event => { if (!event.target.closest('.language-picker')) closeLanguages(); });
document.addEventListener('focusin', event => { if (!popup.hidden && !event.target.closest('.language-picker')) closeLanguages(); });
document.querySelector('.language-picker').addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Escape' && !popup.hidden) { event.preventDefault(); closeLanguages(true); return; }
  if (event.key === 'ArrowDown' && popup.hidden) { event.preventDefault(); openLanguages(); return; }
  if (!popup.hidden && ['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
    const buttons = [...options.querySelectorAll('button')]; if (!buttons.length) return;
    event.preventDefault(); const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : index <= 0 ? buttons.length - 1 : index - 1;
    buttons[next].focus();
  }
  if (event.key === 'Enter' && document.activeElement === search) { const first = options.querySelector('button'); if (first) { event.preventDefault(); first.click(); } }
});
let initialLanguage;
try { initialLanguage = localStorage.getItem('reviewops-site-language'); } catch { /* Browser storage may be disabled. */ }
const requestedLanguage = new URLSearchParams(location.search).get('lang');
if (requestedLanguage) initialLanguage = requestedLanguage;
if (!initialLanguage) { const browserLanguage = navigator.language || 'en'; initialLanguage = browserLanguage.startsWith('zh') ? 'zh-CN' : browserLanguage.split('-')[0]; }
applyLanguage(initialLanguage);
