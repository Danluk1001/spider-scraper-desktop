; Spider Scraper — Windows installer (Inno Setup 6+)
;
; Prerequisites:
;   1. Install Inno Setup: https://jrsoftware.org/isinfo.php
;   2. From repo root, build the EXE (see desktop/spider_scraper.spec)
;   3. Run:  powershell -ExecutionPolicy Bypass -File desktop\installer\prepare_stage.ps1
;   4. Compile this script (right-click → Compile) or:
;        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" desktop\installer\SpiderScraper.iss
;
; Optional Chromium bundle: run fetch_browsers_for_installer.ps1 before prepare_stage.ps1
; so stage\ms-playwright exists. Browsers install to %LOCALAPPDATA%\SpiderScraper\ms-playwright
; which matches desktop\launcher.py for frozen builds.

#define MyAppName "Spider Scraper"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Spider Scraper"
#define MyAppExeName "Spider-Scraper.exe"
#define MyAppAssocName MyAppName + " File"
#define MyAppAssocExt ".myp"
#define MyAppAssocKey StringChange(MyAppAssocName, " ", "") + MyAppAssocExt

[Setup]
AppId={{A7B2E4F1-9C3D-4E8A-B5F6-1D2E3F4A5B6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir=output
OutputBaseFilename=SpiderScraperSetup
; Optional: SetupIconFile=..\resources\icon.ico (add icon.ico under desktop\resources)
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
LicenseFile=
InfoBeforeFile=
InfoAfterFile=
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "stage\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
; Playwright Chromium (~300MB+): included only if stage\ms-playwright exists when you compile
#if DirExists(AddBackslash(SourcePath) + "stage\ms-playwright")
Source: "stage\ms-playwright\*"; DestDir: "{localappdata}\SpiderScraper\ms-playwright"; Flags: ignoreversion recursesubdirs createallsubdirs
#endif

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
