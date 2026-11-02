; ============================================================
;  图片漫画浏览器 —— 安装程序脚本（Inno Setup 6）
;
;  生成方法（任选其一）：
;    1) 双击同目录下的「编译安装包.bat」
;    2) 手动：ISCC.exe ImageViewer_setup.iss
;  产物：发布\图片漫画浏览器_v1.0.0_安装程序.exe
; ============================================================

#define MyAppName "图片漫画浏览器"
#define MyAppVersion "1.0.0"
#define MyAppExeName "图片漫画浏览器.exe"

[Setup]
AppId={{A7C2E9D1-4B6F-4E8A-9C3D-2F1E5B7A8C6D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; 按当前用户安装，无需管理员权限（如需装到 Program Files，删除下面这行）
PrivilegesRequired=lowest
OutputDir=发布
OutputBaseFilename={#MyAppName}_v{#MyAppVersion}_安装程序
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："

[Files]
Source: "发布\图片漫画浏览器\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即运行 {#MyAppName}"; Flags: nowait postinstall skipifsilent
