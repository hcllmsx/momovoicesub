; ───────────────────────────────────────────────────────────────────
; 默默配音助手 - DaVinci Resolve 版 安装器
; ───────────────────────────────────────────────────────────────────

#define MyAppName "默默配音助手 (DaVinci Resolve 版)"
#define MyAppVersion "26.9.7"
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
  TitleLabel, SubLabel, DescLabel: TNewStaticText;
  BtnPanel: TPanel;
  UninstBtn, CancelBtn: TNewButton;
  ContentW, Y: Integer;
begin
  UninstForm := TForm.Create(nil);
  UninstForm.Caption := '卸载默默配音助手 (DaVinci Resolve 版)';
  UninstForm.Position := poScreenCenter;
  UninstForm.BorderStyle := bsDialog;
  UninstForm.Font.Size := 9;
  UninstForm.ClientWidth := 720;

  UninstMainPanel := TPanel.Create(UninstForm);
  UninstMainPanel.Parent := UninstForm;
  UninstMainPanel.Align := alClient;
  UninstMainPanel.BevelOuter := bvNone;
  UninstMainPanel.ParentBackground := False;
  UninstMainPanel.Color := $FFFFFF;

  // 内容可用宽度（窗体客户区 720 - 左边距 24 - 右边距 24）
  ContentW := 672;

  // 从上往下累加 Y 坐标
  Y := 20;

  { 用 TNewStaticText 代替 TLabel：
    TNewStaticText.AutoSize := True 只调高度不缩宽度（这是它与 TLabel 的关键区别），
    配合 WordWrap := True 能正确地按固定 Width 换行并自动撑开高度，
    彻底解决 "每行只有几个字" 和 "文字被裁切" 两个问题。 }

  TitleLabel := TNewStaticText.Create(UninstMainPanel);
  TitleLabel.Parent := UninstMainPanel;
  TitleLabel.Left := 24;
  TitleLabel.Top := Y;
  TitleLabel.Width := ContentW;
  TitleLabel.AutoSize := True;
  TitleLabel.WordWrap := True;
  TitleLabel.Caption := '即将卸载 默默配音助手 (DaVinci Resolve 版)';
  TitleLabel.Font.Size := 11;
  TitleLabel.Font.Style := [fsBold];
  TitleLabel.Font.Color := $333333;
  Y := Y + TitleLabel.Height + 10;

  SubLabel := TNewStaticText.Create(UninstMainPanel);
  SubLabel.Parent := UninstMainPanel;
  SubLabel.Left := 24;
  SubLabel.Top := Y;
  SubLabel.Width := ContentW;
  SubLabel.AutoSize := True;
  SubLabel.WordWrap := True;
  SubLabel.Caption := '请选择是否同时删除用户数据：';
  SubLabel.Font.Size := 9;
  SubLabel.Font.Color := $666666;
  Y := Y + SubLabel.Height + 8;

  UninstDrDataChk := TCheckBox.Create(UninstMainPanel);
  UninstDrDataChk.Parent := UninstMainPanel;
  UninstDrDataChk.Left := 40;
  UninstDrDataChk.Top := Y;
  UninstDrDataChk.Width := ContentW - 16;
  UninstDrDataChk.Height := 20;
  UninstDrDataChk.Caption := '删除插件设置、自填Key、云端登录状态和缓存等用户数据';
  UninstDrDataChk.Checked := False;
  UninstDrDataChk.Font.Size := 9;
  Y := Y + UninstDrDataChk.Height + 6;

  DescLabel := TNewStaticText.Create(UninstMainPanel);
  DescLabel.Parent := UninstMainPanel;
  DescLabel.Left := 40;
  DescLabel.Top := Y;
  DescLabel.Width := ContentW - 16;
  DescLabel.AutoSize := True;
  DescLabel.WordWrap := True;
  DescLabel.Caption := '勾选后将永久删除 %USERPROFILE%\AppData\Roaming\momovoicesub 下的所有数据，无法恢复。不勾选则仅移除插件程序文件，保留用户数据（重装后设置仍在）。';
  DescLabel.Font.Size := 8;
  DescLabel.Font.Color := $999999;
  Y := Y + DescLabel.Height + 16;

  BtnPanel := TPanel.Create(UninstMainPanel);
  BtnPanel.Parent := UninstMainPanel;
  BtnPanel.Align := alBottom;
  BtnPanel.Height := 50;
  BtnPanel.BevelOuter := bvNone;
  BtnPanel.ParentBackground := True;

  UninstBtn := TNewButton.Create(BtnPanel);
  UninstBtn.Parent := BtnPanel;
  UninstBtn.Top := 10;
  UninstBtn.Width := 90;
  UninstBtn.Height := 30;
  UninstBtn.Caption := '卸载(&U)';
  UninstBtn.ModalResult := mrOK;
  UninstBtn.Default := True;

  CancelBtn := TNewButton.Create(BtnPanel);
  CancelBtn.Parent := BtnPanel;
  CancelBtn.Top := 10;
  CancelBtn.Width := 90;
  CancelBtn.Height := 30;
  CancelBtn.Caption := '取消';
  CancelBtn.ModalResult := mrCancel;
  CancelBtn.Cancel := True;

  // 按钮居右排列，留 16px 间距
  CancelBtn.Left := ContentW + 24 - 90;
  UninstBtn.Left := CancelBtn.Left - 90 - 16;

  // 窗体高度 = 内容总高度 + 底部按钮栏
  UninstForm.ClientHeight := Y + 50;

  Result := (UninstForm.ShowModal() = mrOK);
  DeleteDrUserData := UninstDrDataChk.Checked;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir, LegacyDataDir: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    if DeleteDrUserData then
    begin
      // 用户数据存储在 AppData\Roaming\momovoicesub，含：
      //   settings.json(自填Key加密、禁用开关等)、cloud-token.json(云端登录)、
      //   device-fp.txt(设备指纹)、polyphonic-user-dict.json(多音字)、cache/、
      //   Local Storage\leveldb\(手动配音文本等 localStorage，v26.8.14.4+ 迁移至此)
      DataDir := ExpandConstant('{userappdata}\momovoicesub');
      if DirExists(DataDir) then
      begin
        try
          DelTree(DataDir, True, True, True);
        except
        end;
      end;

      // 兼容旧版：v26.8.14.3 及更早版本因未调用 app.setPath('userData')，
      // Electron 按 package.json name 把 localStorage 存在了
      // AppData\Roaming\momovoicesub-resolve-plugin\Local Storage\leveldb\
      // 此处一并清除，确保手动配音文本等 localStorage 彻底删除。
      LegacyDataDir := ExpandConstant('{userappdata}\momovoicesub-resolve-plugin');
      if DirExists(LegacyDataDir) then
      begin
        try
          DelTree(LegacyDataDir, True, True, True);
        except
        end;
      end;
    end;
  end;
end;