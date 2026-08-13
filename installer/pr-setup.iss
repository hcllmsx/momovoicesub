; ───────────────────────────────────────────────────────────────────
; 默默配音助手 - Premiere Pro 版 安装器
; ───────────────────────────────────────────────────────────────────

#define MyAppName "默默配音助手 (Premiere Pro 版)"
#define MyAppVersion "26.8.14"
#define MyAppPublisher "hcllmsx"
#define MyAppURL "https://github.com/hcllmsx/momovoicesub"

[Setup]
AppId={{B7E4F9A1-3C5D-4E8B-9F2A-1A6C7E8D5B4E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
VersionInfoVersion={#MyAppVersion}
VersionInfoProductVersion={#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
OutputDir=..\_output
OutputBaseFilename=momovoicesub-pr-setup-v{#MyAppVersion}
SetupIconFile=src\momovoicesub-pr-favicon.ico
UninstallDisplayIcon={app}\src\momovoicesub-pr-favicon.ico
UninstallDisplayName=默默配音助手 (Premiere Pro 版)
ShowLanguageDialog=no
LanguageDetectionMethod=none

[Languages]
Name: "chinesesimp"; MessagesFile: "src\ChineseSimplified.isl"

[Files]
Source: "payload\pr\*"; DestDir: "{code:GetPrTargetDir}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "src\pr-manage-json.ps1"; DestDir: "{tmp}"; Flags: ignoreversion deleteafterinstall;
Source: "src\pr-manage-json.ps1"; DestDir: "{app}\src"; Flags: ignoreversion;
Source: "src\momovoicesub-pr-favicon.ico"; DestDir: "{app}\src"; Flags: ignoreversion;

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{tmp}\pr-manage-json.ps1"" -Action install -Version ""{#MyAppVersion}"" -Name ""默默配音助手"" -HostMinVersion ""25.6.0"""; StatusMsg: "正在注册 Premiere Pro 插件..."; Flags: runhidden

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\src\pr-manage-json.ps1"" -Action uninstall"; RunOnceId: "RemovePrJson"; Flags: runhidden

[Code]
var
  PrDetected: Boolean;
  PrVersionStr: String;
  DeletePrUserData: Boolean;
  UninstForm: TForm;
  UninstMainPanel: TPanel;
  UninstPrDataChk: TCheckBox;
  UninstPrDataLabel: TLabel;

procedure DetectPremiere();
var
  PrExePath: String;
  PrRegVersion: String;
begin
  PrDetected := False;
  PrVersionStr := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Adobe Premiere Pro.exe', '', PrExePath) then
  begin
    if (PrExePath <> '') and FileExists(RemoveQuotes(PrExePath)) then
    begin
      PrDetected := True;
      PrVersionStr := ExtractFileName(ExtractFileDir(RemoveQuotes(PrExePath)));
    end;
  end;
  if not PrDetected then
  begin
    if RegQueryStringValue(HKLM, 'SOFTWARE\Adobe\Premiere Pro\CurrentVersion', '', PrRegVersion) then
    begin
      PrDetected := True;
      PrVersionStr := 'Premiere Pro ' + PrRegVersion;
    end;
  end;
end;

function GetPrTargetDir(Param: String): String;
begin
  Result := ExpandConstant('{userappdata}\Adobe\UXP\Plugins\External\com.momo.voicesub.pr_{#MyAppVersion}');
end;

function InitializeSetup(): Boolean;
begin
  DetectPremiere();
  Result := True;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  Memo: String;
begin
  Memo := '检测结果:' + NewLine;
  if PrDetected then
    Memo := Memo + '  已检测到 ' + PrVersionStr + NewLine
  else
    Memo := Memo + '  未检测到 Premiere Pro，插件安装后可能无法加载' + NewLine;

  Memo := Memo + NewLine + '安装目录:' + NewLine + '  ' + GetPrTargetDir('');
  Result := Memo;
end;

function InitializeUninstall(): Boolean;
var
  TitleLabel, SubLabel: TLabel;
  BtnPanel: TPanel;
  UninstBtn, CancelBtn: TNewButton;
begin
  UninstForm := TForm.Create(nil);
  UninstForm.Caption := '卸载默默配音助手 (Premiere Pro 版)';
  UninstForm.ClientWidth := 720;
  UninstForm.ClientHeight := 260;
  UninstForm.Position := poScreenCenter;
  UninstForm.BorderStyle := bsDialog;

  UninstMainPanel := TPanel.Create(UninstForm);
  UninstMainPanel.Parent := UninstForm;
  UninstMainPanel.Align := alClient;
  UninstMainPanel.BevelOuter := bvNone;
  UninstMainPanel.ParentBackground := False;
  UninstMainPanel.Color := $FFFFFF;

  TitleLabel := TLabel.Create(UninstMainPanel);
  TitleLabel.Parent := UninstMainPanel;
  TitleLabel.Left := 24;
  TitleLabel.Top := 20;
  TitleLabel.Width := 670;
  TitleLabel.Height := 24;
  TitleLabel.Caption := '即将卸载 默默配音助手 (Premiere Pro 版)';
  TitleLabel.Font.Size := 11;
  TitleLabel.Font.Style := [fsBold];
  TitleLabel.Font.Color := $333333;

  SubLabel := TLabel.Create(UninstMainPanel);
  SubLabel.Parent := UninstMainPanel;
  SubLabel.Left := 24;
  SubLabel.Top := 50;
  SubLabel.Width := 670;
  SubLabel.Height := 20;
  SubLabel.Caption := '请选择是否同时删除以下数据：';
  SubLabel.Font.Size := 9;
  SubLabel.Font.Color := $666666;

  UninstPrDataChk := TCheckBox.Create(UninstMainPanel);
  UninstPrDataChk.Parent := UninstMainPanel;
  UninstPrDataChk.Left := 40;
  UninstPrDataChk.Top := 80;
  UninstPrDataChk.Width := 650;
  UninstPrDataChk.Height := 20;
  UninstPrDataChk.Caption := '删除所有 PR 版本的用户数据 (AppData\Adobe\UXP\PluginsStorage)';
  UninstPrDataChk.Checked := False;
  UninstPrDataChk.Font.Size := 9;

  UninstPrDataLabel := TLabel.Create(UninstMainPanel);
  UninstPrDataLabel.Parent := UninstMainPanel;
  UninstPrDataLabel.Left := 40;
  UninstPrDataLabel.Top := 110;
  UninstPrDataLabel.Width := 650;
  UninstPrDataLabel.Height := 50;
  UninstPrDataLabel.Caption := '勾选后将永久删除所有配置和缓存，无法恢复。' + #13#10 + '不勾选则仅移除程序文件，保留用户数据。';
  UninstPrDataLabel.Font.Size := 8;
  UninstPrDataLabel.Font.Color := $999999;
  UninstPrDataLabel.WordWrap := True;

  BtnPanel := TPanel.Create(UninstMainPanel);
  BtnPanel.Parent := UninstMainPanel;
  BtnPanel.Align := alBottom;
  BtnPanel.Height := 50;
  BtnPanel.BevelOuter := bvNone;
  BtnPanel.ParentBackground := True;

  UninstBtn := TNewButton.Create(BtnPanel);
  UninstBtn.Parent := BtnPanel;
  UninstBtn.Left := 280;
  UninstBtn.Top := 10;
  UninstBtn.Width := 80;
  UninstBtn.Height := 30;
  UninstBtn.Caption := '卸载(&U)';
  UninstBtn.ModalResult := mrOK;
  UninstBtn.Default := True;

  CancelBtn := TNewButton.Create(BtnPanel);
  CancelBtn.Parent := BtnPanel;
  CancelBtn.Left := 370;
  CancelBtn.Top := 10;
  CancelBtn.Width := 80;
  CancelBtn.Height := 30;
  CancelBtn.Caption := '取消';
  CancelBtn.ModalResult := mrCancel;
  CancelBtn.Cancel := True;

  Result := (UninstForm.ShowModal() = mrOK);
  DeletePrUserData := UninstPrDataChk.Checked;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  PrStorageRoot, PrEntryPath: String;
  FindRec: TFindRec;
begin
  if CurUninstallStep <> usUninstall then Exit;
  if DeletePrUserData then
  begin
    PrStorageRoot := ExpandConstant('{userappdata}\Adobe\UXP\PluginsStorage\PPRO');
    if DirExists(PrStorageRoot) then
    begin
      if FindFirst(AddBackslash(PrStorageRoot) + '*', FindRec) then
      begin
        try
          repeat
            if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
            begin
              PrEntryPath := AddBackslash(AddBackslash(PrStorageRoot) + FindRec.Name) + 'External\com.momo.voicesub.pr';
              if DirExists(PrEntryPath) then
              begin
                try
                  DelTree(PrEntryPath, True, True, True);
                except
                end;
              end;
            end;
          until not FindNext(FindRec);
        finally
          FindClose(FindRec);
        end;
      end;
    end;
  end;
end;