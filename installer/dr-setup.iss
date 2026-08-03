; ───────────────────────────────────────────────────────────────────
; 默默配音助手 - DaVinci Resolve 版 安装器
; ───────────────────────────────────────────────────────────────────

#define MyAppName "默默配音助手 (DaVinci Resolve 版)"
#define MyAppVersion "26.8.4"
#define MyAppPublisher "hcllmsx"
#define MyAppURL "https://github.com/hcllmsx/momovoicesub"

[Setup]
AppId={{B7E4F9A1-3C5D-4E8B-9F2A-1A6C7E8D5B3F}
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
OutputBaseFilename=momovoicesub-dr-setup-v{#MyAppVersion}
SetupIconFile=src\momovoicesub-dr-favicon.ico
UninstallDisplayIcon={app}\src\momovoicesub-dr-favicon.ico
UninstallDisplayName=默默配音助手 (DaVinci Resolve 版)
ShowLanguageDialog=no
LanguageDetectionMethod=none

[Languages]
Name: "chinesesimp"; MessagesFile: "src\ChineseSimplified.isl"

[Files]
Source: "payload\dr\*"; DestDir: "{code:GetDrTargetDir}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "src\momovoicesub-dr-favicon.ico"; DestDir: "{app}\src"; Flags: ignoreversion

[UninstallRun]
Filename: "cmd.exe"; Parameters: "/c rmdir /s /q ""{code:GetDrTargetDir}"""; Flags: runhidden

[Code]
var
  DrDetected, DrNodeFound: Boolean;
  DrVersionStr: String;
  DeleteDrUserData: Boolean;
  UninstForm: TForm;
  UninstMainPanel: TPanel;
  UninstDrDataChk: TCheckBox;
  UninstDrDataLabel: TLabel;

procedure DetectDaVinci();
var
  DrRegVersion: String;
begin
  DrDetected := False;
  DrNodeFound := False;
  DrVersionStr := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\Blackmagic Design\DaVinci Resolve', 'Version', DrRegVersion) then
  begin
    DrDetected := True;
    DrVersionStr := 'DaVinci Resolve ' + DrRegVersion;
  end;
  if FileExists(ExpandConstant('{commonappdata}\Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node')) then
    DrNodeFound := True;
end;

function GetDrTargetDir(Param: String): String;
begin
  Result := ExpandConstant('{commonappdata}\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\com.momo.voicesub.dr');
end;

function InitializeSetup(): Boolean;
begin
  DetectDaVinci();
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  SourceNode, TargetNode: String;
begin
  if CurStep = ssPostInstall then
  begin
    SourceNode := ExpandConstant('{commonappdata}\Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node');
    TargetNode := GetDrTargetDir('') + '\WorkflowIntegration.node';
    if FileExists(SourceNode) then
    begin
      if FileCopy(SourceNode, TargetNode, False) then
        Log('已复制 WorkflowIntegration.node 到 DR 插件目录')
      else
        Log('复制 WorkflowIntegration.node 失败');
    end
    else
      Log('WorkflowIntegration.node 源文件不存在，跳过复制');
  end;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  Memo: String;
begin
  Memo := '检测结果:' + NewLine;
  if DrDetected then
    Memo := Memo + '  已检测到 ' + DrVersionStr + NewLine
  else
    Memo := Memo + '  未检测到 DaVinci Resolve，插件安装后可能无法加载' + NewLine;

  if DrDetected and not DrNodeFound then
    Memo := Memo + '  ⚠ WorkflowIntegration.node 未找到，可能影响插件运行' + NewLine;

  Memo := Memo + NewLine + '安装目录:' + NewLine + '  ' + GetDrTargetDir('');
  Result := Memo;
end;

function InitializeUninstall(): Boolean;
var
  TitleLabel, SubLabel: TLabel;
  BtnPanel: TPanel;
  UninstBtn, CancelBtn: TNewButton;
begin
  UninstForm := TForm.Create(nil);
  UninstForm.Caption := '卸载默默配音助手 (DaVinci Resolve 版)';
  UninstForm.ClientWidth := 720;
  UninstForm.ClientHeight := 240;
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
  TitleLabel.Caption := '即将卸载 默默配音助手 (DaVinci Resolve 版)';
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

  UninstDrDataChk := TCheckBox.Create(UninstMainPanel);
  UninstDrDataChk.Parent := UninstMainPanel;
  UninstDrDataChk.Left := 40;
  UninstDrDataChk.Top := 80;
  UninstDrDataChk.Width := 650;
  UninstDrDataChk.Height := 20;
  UninstDrDataChk.Caption := '删除插件设置、缓存和用户数据 (ProgramData\com.momo.voicesub.dr)';
  UninstDrDataChk.Checked := False;
  UninstDrDataChk.Font.Size := 9;

  UninstDrDataLabel := TLabel.Create(UninstMainPanel);
  UninstDrDataLabel.Parent := UninstMainPanel;
  UninstDrDataLabel.Left := 40;
  UninstDrDataLabel.Top := 110;
  UninstDrDataLabel.Width := 650;
  UninstDrDataLabel.Height := 40;
  UninstDrDataLabel.Caption := '勾选后将永久删除所有配置和缓存，无法恢复。' + #13#10 + '不勾选则仅移除程序文件，保留用户数据。';
  UninstDrDataLabel.Font.Size := 8;
  UninstDrDataLabel.Font.Color := $999999;
  UninstDrDataLabel.WordWrap := True;

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
  DeleteDrUserData := UninstDrDataChk.Checked;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    if DeleteDrUserData then
    begin
      DataDir := ExpandConstant('{commonappdata}\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\com.momo.voicesub.dr');
      if DirExists(DataDir) then
      begin
        try
          DelTree(DataDir, True, True, True);
        except
        end;
      end;
    end;
  end;
end;