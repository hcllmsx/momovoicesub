; ───────────────────────────────────────────────────────────────────
; 默默配音助手 安装器 - Inno Setup 脚本
; 统一安装达芬奇版 + Premiere Pro 版插件
; ───────────────────────────────────────────────────────────────────

#define MyAppName "默默配音助手"
#define MyAppVersion "26.7.25"
#define PrPluginVersion "26.7.25"
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
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
OutputDir=..\_output
OutputBaseFilename=momovoicesub-setup-v{#MyAppVersion}
SetupIconFile=src\momovoicesub-favicon.ico
UninstallDisplayIcon={app}\src\momovoicesub-favicon.ico
UninstallDisplayName=默默配音助手
ShowLanguageDialog=no
LanguageDetectionMethod=none

[Languages]
Name: "chinesesimp"; MessagesFile: "src\ChineseSimplified.isl"

[Types]
Name: "custom"; Description: "自定义安装"; Flags: iscustom

[Components]
Name: "dr"; Description: "安装 DaVinci Resolve 版插件"; Types: custom; Flags: checkablealone
Name: "pr"; Description: "安装 Premiere Pro 版插件"; Types: custom; Flags: checkablealone

[Files]
; ─── DR 版插件文件（装到 ProgramData）───
Source: "payload\dr\*"; DestDir: "{code:GetDrTargetDir}"; Components: dr; Flags: recursesubdirs createallsubdirs ignoreversion;

; ─── PR 版插件文件（装到 AppData）───
Source: "payload\pr\*"; DestDir: "{code:GetPrTargetDir}"; Components: pr; Flags: recursesubdirs createallsubdirs ignoreversion;

; ─── JSON 管理脚本（安装时临时使用 + 卸载时持久使用）───
Source: "src\pr-manage-json.ps1"; DestDir: "{tmp}"; Flags: ignoreversion deleteafterinstall;
Source: "src\pr-manage-json.ps1"; DestDir: "{app}\src"; Flags: ignoreversion;

; ─── 卸载器图标（UninstallDisplayIcon 引用）───
Source: "src\momovoicesub-favicon.ico"; DestDir: "{app}\src"; Flags: ignoreversion;

[Run]
; ─── PR: 注册到 PluginsInfo JSON ───
Components: pr; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{tmp}\pr-manage-json.ps1"" -Action install -Version ""{#PrPluginVersion}"" -Name ""默默配音助手"" -HostMinVersion ""25.6.0"""; StatusMsg: "正在注册 Premiere Pro 插件..."; Flags: runhidden

[UninstallRun]
; ─── PR: 从 PluginsInfo JSON 移除 ───
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\src\pr-manage-json.ps1"" -Action uninstall"; RunOnceId: "RemovePrJson"; Flags: runhidden

[Code]
// ─── 全局变量 ───
var
  DrDetected, PrDetected, DrNodeFound: Boolean;
  DrVersionStr, PrVersionStr: String;
  DeleteDrUserData, DeletePrUserData: Boolean;
  // 卸载向导表单控件（全局，供事件处理过程访问）
  UninstForm: TForm;
  UninstMainPanel: TPanel;
  UninstDrDataChk, UninstPrDataChk: TCheckBox;
  UninstDrDataLabel, UninstPrDataLabel: TLabel;

// ─── 检测 DaVinci Resolve ───
procedure DetectDaVinci();
var
  DrRegVersion: String;
begin
  DrDetected := False;
  DrNodeFound := False;
  DrVersionStr := '';

  // 注册表查版本（覆盖自定义安装位置）
  if RegQueryStringValue(HKLM, 'SOFTWARE\Blackmagic Design\DaVinci Resolve', 'Version', DrRegVersion) then
  begin
    DrDetected := True;
    DrVersionStr := 'DaVinci Resolve ' + DrRegVersion;
  end;

  // 检测 WorkflowIntegration.node（固定在 ProgramData）
  if FileExists(ExpandConstant('{commonappdata}\Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node')) then
  begin
    DrNodeFound := True;
  end;
end;

// ─── 检测 Premiere Pro ───
procedure DetectPremiere();
var
  PrExePath: String;
  PrRegVersion: String;
begin
  PrDetected := False;
  PrVersionStr := '';

  // 注册表 App Paths（覆盖自定义安装位置）
  if RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Adobe Premiere Pro.exe', '', PrExePath) then
  begin
    if (PrExePath <> '') and FileExists(RemoveQuotes(PrExePath)) then
    begin
      PrDetected := True;
      PrVersionStr := ExtractFileName(ExtractFileDir(RemoveQuotes(PrExePath)));
    end;
  end;

  // 注册表版本号兜底
  if not PrDetected then
  begin
    if RegQueryStringValue(HKLM, 'SOFTWARE\Adobe\Premiere Pro\CurrentVersion', '', PrRegVersion) then
    begin
      PrDetected := True;
      PrVersionStr := 'Premiere Pro ' + PrRegVersion;
    end;
  end;
end;

// ─── 获取 DR 插件目标目录 ───
function GetDrTargetDir(Param: String): String;
begin
  Result := ExpandConstant('{commonappdata}\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\com.momo.voicesub.dr');
end;

// ─── 获取 PR 插件目标目录 ───
function GetPrTargetDir(Param: String): String;
begin
  Result := ExpandConstant('{userappdata}\Adobe\UXP\Plugins\External\com.momo.voicesub.pr_{#PrPluginVersion}');
end;

// ─── 初始化：执行检测 ───
function InitializeSetup(): Boolean;
begin
  DetectDaVinci();
  DetectPremiere();
  Result := True;
end;

// ─── 组件页：自动勾选已检测到的组件 ───
procedure CurPageChanged(CurPageID: Integer);
var
  I: Integer;
begin
  if CurPageID = wpSelectComponents then
  begin
    for I := 0 to WizardForm.ComponentsList.Items.Count - 1 do
    begin
      if Pos('DaVinci Resolve', WizardForm.ComponentsList.ItemCaption[I]) > 0 then
        WizardForm.ComponentsList.Checked[I] := DrDetected
      else if Pos('Premiere Pro', WizardForm.ComponentsList.ItemCaption[I]) > 0 then
        WizardForm.ComponentsList.Checked[I] := PrDetected;
    end;
  end;
end;

// ─── 准备安装：检查依赖 ───
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Msg: String;
  HasDr, HasPr: Boolean;
begin
  Result := '';
  HasDr := IsComponentSelected('dr');
  HasPr := IsComponentSelected('pr');

  // DR 依赖检查：WorkflowIntegration.node
  if HasDr and not DrNodeFound then
  begin
    Msg := '未在默认位置找到 DaVinci Resolve 的 WorkflowIntegration.node 文件。' + #13#10 + #13#10 +
           '这通常是因为安装 DaVinci Resolve 时没有勾选「Developer Workflow Integration 示例」组件。' + #13#10 +
           '插件仍然会被安装，但启动时可能无法正常加载。' + #13#10 + #13#10 +
           '是否继续安装？';
    if MsgBox(Msg, mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDNO then
    begin
      Result := '用户取消安装。';
      Exit;
    end;
  end;

  // 两个都没选
  if (not HasDr) and (not HasPr) then
  begin
    Result := '请至少选择一个要安装的组件。';
    Exit;
  end;
end;

// ─── 安装后：复制 WorkflowIntegration.node 到 DR 插件目录 ───
procedure CurStepChanged(CurStep: TSetupStep);
var
  SourceNode, TargetNode: String;
begin
  if CurStep = ssPostInstall then
  begin
    if IsComponentSelected('dr') then
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
end;

// ─── Ready 页摘要 ───
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  Memo: String;
begin
  Memo := '检测结果:' + NewLine;
  if DrDetected then
    Memo := Memo + '  ✅ ' + DrVersionStr + NewLine
  else
    Memo := Memo + '  ⚠️ 未检测到 DaVinci Resolve' + NewLine;

  if DrDetected and not DrNodeFound then
    Memo := Memo + '     ⚠️ WorkflowIntegration.node 未找到' + NewLine;

  if PrDetected then
    Memo := Memo + '  ✅ ' + PrVersionStr + NewLine
  else
    Memo := Memo + '  ⚠️ 未检测到 Premiere Pro' + NewLine;

  Memo := Memo + NewLine + '将安装:' + NewLine + MemoComponentsInfo;

  Result := Memo;
end;

// ─── 卸载开始前：单页向导选择是否删除用户数据 ───
function InitializeUninstall(): Boolean;
var
  FormWidth, FormHeight: Integer;
  ClientW, ClientH, ContentH, ButtonAreaH: Integer;
  ModalResult: Integer;
  TitleLabel, DescLabel: TLabel;
  CancelBtn, OkBtn: TButton;
  ButtonPanel: TPanel;
begin
  Result := True;
  DeleteDrUserData := False;
  DeletePrUserData := False;

  FormWidth := ScaleX(520);
  FormHeight := ScaleY(320);

  UninstForm := TForm.Create(nil);
  try
    UninstForm.Caption := '默默配音助手 - 卸载选项';
    UninstForm.Width := FormWidth;
    UninstForm.Height := FormHeight;
    UninstForm.Position := poScreenCenter;
    // 固定大小对话框，不可拉宽拉高
    UninstForm.BorderStyle := bsDialog;
    UninstForm.BorderIcons := [biSystemMenu];
    UninstForm.Font.Size := 9;

    // ─── 读取 ClientWidth / ClientHeight（手动布局）───
    ClientW := UninstForm.ClientWidth;
    ClientH := UninstForm.ClientHeight;
    ButtonAreaH := ScaleY(50);
    ContentH := ClientH - ButtonAreaH;

    // ─── 底部按钮容器 ───
    ButtonPanel := TPanel.Create(UninstForm);
    ButtonPanel.Parent := UninstForm;
    ButtonPanel.SetBounds(0, ContentH, ClientW, ButtonAreaH);
    ButtonPanel.BevelOuter := bvNone;

    // === 主面板 ===
    UninstMainPanel := TPanel.Create(UninstForm);
    UninstMainPanel.Parent := UninstForm;
    UninstMainPanel.SetBounds(0, 0, ClientW, ContentH);
    UninstMainPanel.BevelOuter := bvNone;

    // 标题
    TitleLabel := TLabel.Create(UninstForm);
    TitleLabel.Parent := UninstMainPanel;
    TitleLabel.SetBounds(ScaleX(20), ScaleY(20), ClientW - ScaleX(40), ScaleY(24));
    TitleLabel.AutoSize := False;
    TitleLabel.Font.Size := 11;
    TitleLabel.Font.Style := [fsBold];
    TitleLabel.Caption := '请选择是否同时删除用户数据：';

    // 描述
    DescLabel := TLabel.Create(UninstForm);
    DescLabel.Parent := UninstMainPanel;
    DescLabel.SetBounds(ScaleX(20), ScaleY(54), ClientW - ScaleX(40), ScaleY(40));
    DescLabel.AutoSize := False;
    DescLabel.WordWrap := True;
    DescLabel.Caption := '用户数据包括 Azure Speech Key、插件设置、多音字字典、TTS 音频缓存等。保留则重装后自动恢复，删除则需重新填写。';

    // DR 用户数据选项（始终显示）
    UninstDrDataChk := TCheckBox.Create(UninstForm);
    UninstDrDataChk.Parent := UninstMainPanel;
    UninstDrDataChk.SetBounds(ScaleX(24), ScaleY(110), ClientW - ScaleX(48), ScaleY(20));
    UninstDrDataChk.Caption := '删除 DaVinci Resolve 版用户数据';
    UninstDrDataChk.Checked := False;

    UninstDrDataLabel := TLabel.Create(UninstForm);
    UninstDrDataLabel.Parent := UninstMainPanel;
    UninstDrDataLabel.SetBounds(ScaleX(44), ScaleY(132), ClientW - ScaleX(68), ScaleY(40));
    UninstDrDataLabel.AutoSize := False;
    UninstDrDataLabel.WordWrap := True;
    UninstDrDataLabel.Font.Color := clGrayText;
    UninstDrDataLabel.Caption := '包括：Azure Speech Key、插件设置、多音字字典、TTS 音频缓存';

    // PR 用户数据选项（始终显示）
    UninstPrDataChk := TCheckBox.Create(UninstForm);
    UninstPrDataChk.Parent := UninstMainPanel;
    UninstPrDataChk.SetBounds(ScaleX(24), ScaleY(180), ClientW - ScaleX(48), ScaleY(20));
    UninstPrDataChk.Caption := '删除 Premiere Pro 版用户数据（所有 PR 版本）';
    UninstPrDataChk.Checked := False;

    UninstPrDataLabel := TLabel.Create(UninstForm);
    UninstPrDataLabel.Parent := UninstMainPanel;
    UninstPrDataLabel.SetBounds(ScaleX(44), ScaleY(202), ClientW - ScaleX(68), ScaleY(40));
    UninstPrDataLabel.AutoSize := False;
    UninstPrDataLabel.WordWrap := True;
    UninstPrDataLabel.Font.Color := clGrayText;
    UninstPrDataLabel.Caption := '包括：Azure Speech Key、插件设置、多音字字典、TTS 音频缓存、localStorage';

    // === 按钮 ===
    // 取消按钮
    CancelBtn := TButton.Create(UninstForm);
    CancelBtn.Parent := ButtonPanel;
    CancelBtn.SetBounds(ClientW - ScaleX(184), ScaleY(11), ScaleX(80), ScaleY(28));
    CancelBtn.Caption := '取消';
    CancelBtn.Cancel := True;
    CancelBtn.ModalResult := mrCancel;

    // 开始卸载按钮
    OkBtn := TButton.Create(UninstForm);
    OkBtn.Parent := ButtonPanel;
    OkBtn.SetBounds(ClientW - ScaleX(96), ScaleY(11), ScaleX(80), ScaleY(28));
    OkBtn.Caption := '开始卸载';
    OkBtn.Default := True;
    OkBtn.ModalResult := mrOk;

    // === 显示表单 ===
    ModalResult := UninstForm.ShowModal;

    if ModalResult = mrOk then
    begin
      // 用户点击「开始卸载」，读取勾选状态
      DeleteDrUserData := UninstDrDataChk.Checked;
      DeletePrUserData := UninstPrDataChk.Checked;
      Result := True;
    end
    else
    begin
      // 用户点击「取消」→ 取消整个卸载
      Result := False;
    end;
  finally
    UninstForm.Free;
  end;
end;

// ─── 卸载过程中：根据用户勾选删除对应的用户数据 ───
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DrDataDir, PrStorageRoot, PrEntryPath: String;
  FindRec: TFindRec;
begin
  if CurUninstallStep <> usUninstall then Exit;

  // ─── 删除 DR 用户数据 ───
  if DeleteDrUserData then
  begin
    DrDataDir := ExpandConstant('{userappdata}\momovoicesub');
    if DirExists(DrDataDir) then
    begin
      DelTree(DrDataDir, True, True, True);
      Log('已删除 DR 用户数据: ' + DrDataDir);
    end;
  end;

  // ─── 删除 PR 用户数据（遍历所有 PR 版本目录）───
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
                DelTree(PrEntryPath, True, True, True);
                Log('已删除 PR 用户数据: ' + PrEntryPath);
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
