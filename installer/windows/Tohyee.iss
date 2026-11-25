; Tohyee for Windows: one installer with the Tohyee server, its own PostgreSQL,
; and two Windows services that start when the computer starts.
; Built by installer/windows/build.ps1 (on GitHub's Windows runners):
;   ISCC /DAppVersion=x.y.z /DSourceDir=<staging> /DOutputDir=<out> Tohyee.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\windows\stage"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist\windows"
#endif

[Setup]
AppId={{8C7C1E2B-5F0A-4B8E-9C1D-6A1F3E7B2D40}
AppName=Tohyee
AppVersion={#AppVersion}
AppVerName=Tohyee {#AppVersion}
AppPublisher=Tohyee
AppPublisherURL=https://github.com/Willy-nz/Tohyee-ERP
AppSupportURL=https://github.com/Willy-nz/Tohyee-ERP/issues
DefaultDirName={autopf}\Tohyee
DisableDirPage=yes
DefaultGroupName=Tohyee
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=TohyeeSetup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
; One TohyeeSetup at a time (the tray's Install and Update now could otherwise start two).
SetupMutex=TohyeeSetupMutex,Global\TohyeeSetupMutex
; The only per-user setting is starting the tray icon when you sign in.
UsedUserAreasWarning=no
UninstallDisplayName=Tohyee
UninstallDisplayIcon={app}\node\node.exe

[Tasks]
Name: "desktopicon"; Description: "Add a Tohyee shortcut to the desktop"
Name: "starttray"; Description: "Start the Tohyee server app (the icon by the clock) when I sign in to Windows"

[InstallDelete]
; The old program files aren't deleted here any more: update-guard.ps1 moves
; them into {app}\previous before anything is copied (PrepareToInstall), so a
; failed update can put them back. The new files go into empty folders.
; Older versions opened the server settings in the browser.
Type: files; Name: "{group}\Tohyee server settings.url"

[Files]
; Run from setup's own temporary folder before anything is copied (PrepareToInstall).
Source: "{#SourceDir}\scripts\update-guard.ps1"; Flags: dontcopy
Source: "{#SourceDir}\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SourceDir}\node\*"; DestDir: "{app}\node"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SourceDir}\pgsql\*"; DestDir: "{app}\pgsql"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SourceDir}\service\*"; DestDir: "{app}\service"; Flags: ignoreversion
Source: "{#SourceDir}\cloudflared\*"; DestDir: "{app}\cloudflared"; Flags: ignoreversion
Source: "{#SourceDir}\scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "{#SourceDir}\tray\*"; DestDir: "{app}\tray"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SourceDir}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\vc_redist.x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

[INI]
Filename: "{group}\Open Tohyee.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:3000"
Filename: "{autodesktop}\Tohyee.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:3000"; Tasks: desktopicon
Filename: "{group}\Tohyee server settings.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:3001/server"

[Icons]
Name: "{group}\Tohyee server settings"; Filename: "{app}\tray\TohyeeTray.exe"; Parameters: "--settings"; Comment: "Organisations, users, phone access, backups, email and updates (this computer only)"
Name: "{group}\Back up Tohyee"; Filename: "{app}\tray\TohyeeTray.exe"; Parameters: "--back-up"; Comment: "Back up every organisation now, encrypted, to the backup folder (sign in first)"
Name: "{group}\Tohyee logs"; Filename: "{commonappdata}\Tohyee\logs"
Name: "{group}\Uninstall Tohyee"; Filename: "{uninstallexe}"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\previous"
Type: files; Name: "{group}\Open Tohyee.url"
Type: files; Name: "{autodesktop}\Tohyee.url"
Type: files; Name: "{group}\Tohyee server settings.url"

[Registry]
; Start the tray icon when this person signs in to Windows (like a media server's).
; The app's menu turns this off and on again.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Tohyee"; ValueData: """{app}\tray\TohyeeTray.exe"""; Tasks: starttray; Flags: uninsdeletevalue

[Run]
Filename: "{app}\tray\TohyeeTray.exe"; Flags: nowait runasoriginaluser skipifsilent
; Install on the server app's Updates page runs this setup silently with
; /RESTARTTRAY=yes, so the app comes back to say how the update went.
Filename: "{app}\tray\TohyeeTray.exe"; Parameters: "--after-update"; Flags: nowait runasoriginaluser; Check: RestartTrayAfterUpdate
Filename: "{code:GetOpenUrl}"; Description: "Open Tohyee now"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/IM TohyeeTray.exe /F"; Flags: runhidden waituntilterminated; RunOnceId: "StopTohyeeTray"
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\remove-services.ps1"" -InstallDir ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveTohyeeServices"

[Code]
var
  SetupOk: Boolean;
  FirstInstall: Boolean;
  SetupToken: String;
  TohyeeUrl: String;
  TokenEdit: TNewEdit;
  { Update safety (update-guard.ps1, UPD10-UPD13). }
  GuardScript: String;
  Prepared: Boolean;
  UpdateMessage: String;
  CustomExitCode: Integer;

function PowerShellExe(): String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

{ Started silently by the server app's Install: start the app again afterwards. }
function RestartTrayAfterUpdate(): Boolean;
begin
  Result := WizardSilent() and (CompareText(ExpandConstant('{param:RESTARTTRAY|no}'), 'yes') = 0);
end;

function GetOpenUrl(Param: String): String;
begin
  if TohyeeUrl = '' then
    Result := 'http://localhost:3000'
  else if FirstInstall then
    Result := TohyeeUrl + '/setup'
  else
    Result := TohyeeUrl;
end;

{ The first line update-guard.ps1 wrote for us, or Fallback. }
function ReadGuardMessage(FileName: String; Fallback: String): String;
var
  Lines: TArrayOfString;
begin
  Result := Fallback;
  if LoadStringsFromFile(FileName, Lines) and (GetArrayLength(Lines) > 0) and (Trim(Lines[0]) <> '') then
    Result := Trim(Lines[0]);
end;

{ Runs update-guard.ps1 with these arguments and returns its exit code (-1 if it couldn't run). }
function RunGuard(Arguments: String; ResultFile: String): Integer;
var
  ResultCode: Integer;
begin
  DeleteFile(ResultFile);
  if Exec(PowerShellExe(), '-NoProfile -ExecutionPolicy Bypass -File "' + GuardScript + '" ' + Arguments +
      ' -InstallDir "' + ExpandConstant('{app}') + '" -Version "{#AppVersion}" -ResultFile "' + ResultFile + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := ResultCode
  else
    Result := -1;
end;

{ Before any file is copied. update-guard.ps1 turns off the services'
  restart-on-failure and automatic start, stops both services and waits until
  they really are stopped (PostgreSQL only with a clean shutdown, never forced),
  then moves the old program into the previous folder. If it can't, it puts
  everything back and starts Tohyee again, and setup stops here (exit code 7)
  with nothing changed. Before this, a stop that failed was ignored, Windows
  restarted Tohyee mid-copy, and a failed update left no program at all. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM TohyeeTray.exe /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  ExtractTemporaryFile('update-guard.ps1');
  GuardScript := ExpandConstant('{tmp}\update-guard.ps1');
  if RunGuard('-Mode Prepare', ExpandConstant('{tmp}\update-guard-result.txt')) <> 0 then
  begin
    Result := ReadGuardMessage(ExpandConstant('{tmp}\update-guard-result.txt'),
      'Tohyee couldn''t be stopped for the update, so nothing was changed. Try again; if it happens again, restart the computer first.');
    Log('Update guard: ' + Result);
    exit;
  end;
  Prepared := True;
end;

procedure InitializeWizard();
begin
  TokenEdit := TNewEdit.Create(WizardForm);
  TokenEdit.Parent := WizardForm.FinishedPage;
  TokenEdit.ReadOnly := True;
  TokenEdit.Visible := False;
end;

{ The update stopped before the new version started: put the old one back.
  Does nothing once the new version has started (it may have upgraded the
  databases) or when there's nothing to put back. }
procedure RestorePrevious();
var
  Code: Integer;
begin
  if not Prepared then
    exit;
  Prepared := False;
  Code := RunGuard('-Mode Restore', ExpandConstant('{tmp}\update-guard-restore.txt'));
  Log('Update guard restore: exit code ' + IntToStr(Code));
  if Code = 0 then
  begin
    UpdateMessage := ReadGuardMessage(ExpandConstant('{tmp}\update-guard-restore.txt'), 'The update didn''t work, so the previous version was put back.');
    CustomExitCode := 20;
  end
  else if Code = 1 then
  begin
    UpdateMessage := ReadGuardMessage(ExpandConstant('{tmp}\update-guard-restore.txt'), 'The update didn''t work, and the previous version couldn''t be put back.');
    CustomExitCode := 22;
  end
  else
    CustomExitCode := 21;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  ResultFile: String;
  ConfigureArgs: String;
  Lines: TArrayOfString;
begin
  if CurStep <> ssPostInstall then
    exit;

  WizardForm.StatusLabel.Caption := 'Installing the Microsoft Visual C++ runtime...';
  if Exec(ExpandConstant('{tmp}\vc_redist.x64.exe'), '/install /quiet /norestart', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    { 0 installed, 1638 a newer one is already there, 3010 installed but wants a restart. }
    Log('Visual C++ runtime: exit code ' + IntToStr(ResultCode))
  else
    Log('Visual C++ runtime: could not be started');

  WizardForm.StatusLabel.Caption := 'Setting up the database and starting Tohyee (this can take a few minutes)...';
  ResultFile := ExpandConstant('{tmp}\tohyee-setup-result.txt');
  ConfigureArgs := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\scripts\configure-tohyee.ps1') +
    '" -InstallDir "' + ExpandConstant('{app}') + '" -ResultFile "' + ResultFile + '" -Version "{#AppVersion}"';
  { Tests only (test-install.ps1): /TESTFAILAT=before-start makes the update fail on purpose there. }
  if ExpandConstant('{param:TESTFAILAT|}') <> '' then
    ConfigureArgs := ConfigureArgs + ' -TestFailAt "' + ExpandConstant('{param:TESTFAILAT|}') + '"';
  Exec(PowerShellExe(), ConfigureArgs, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  SetupOk := (ResultCode = 0) and LoadStringsFromFile(ResultFile, Lines) and (GetArrayLength(Lines) >= 3);
  if SetupOk then
  begin
    Prepared := False;
    FirstInstall := Lines[0] = 'first-install';
    SetupToken := Lines[1];
    TohyeeUrl := Lines[2];
  end
  else
  begin
    RestorePrevious();
    if CustomExitCode = 0 then
      CustomExitCode := 21;
    if UpdateMessage = '' then
      UpdateMessage := 'Tohyee was copied to this computer, but setting up its database and services failed.';
    SuppressibleMsgBox(UpdateMessage + #13#10#13#10 +
      'The details are in ' + ExpandConstant('{commonappdata}\Tohyee\logs\setup.log') + '.' + #13#10 +
      'Run TohyeeSetup again to retry, or send that file to whoever is helping you.', mbError, MB_OK, IDOK);
  end;
end;

{ 0 when Tohyee is running the new version. 20: it failed and the previous
  version was put back and is running. 21: copied, but not running (see
  setup.log). 22: failed, and putting the previous version back failed too. }
function GetCustomSetupExitCode(): Integer;
begin
  Result := CustomExitCode;
end;

{ Setup is ending. If it stopped after the old program was moved aside (the
  copy failed, or it was cancelled), put the old program back now. }
procedure DeinitializeSetup();
begin
  RestorePrevious();
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID <> wpFinished then
    exit;
  if not SetupOk then
  begin
    WizardForm.FinishedLabel.Caption := UpdateMessage + ' See ' +
      ExpandConstant('{commonappdata}\Tohyee\logs\setup.log') + ' for what went wrong.';
    exit;
  end;
  if FirstInstall then
  begin
    WizardForm.FinishedLabel.Caption := 'Tohyee is running at ' + TohyeeUrl + ' and starts by itself whenever this computer starts.' + #13#10#13#10 +
      'Next, create your admin login on the first-time setup page. It asks for this setup token (select it and press Ctrl+C to copy):';
    WizardForm.AdjustLabelHeight(WizardForm.FinishedLabel);
    TokenEdit.Text := SetupToken;
    TokenEdit.Left := WizardForm.FinishedLabel.Left;
    TokenEdit.Width := WizardForm.FinishedLabel.Width;
    TokenEdit.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(8);
    TokenEdit.Visible := True;
    WizardForm.RunList.Top := TokenEdit.Top + TokenEdit.Height + ScaleY(16);
  end
  else
    WizardForm.FinishedLabel.Caption := 'Tohyee has been updated and is running at ' + TohyeeUrl + '. Your data and passwords were kept.';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    SuppressibleMsgBox('Tohyee has been removed. Your data was kept in ' + ExpandConstant('{commonappdata}\Tohyee') +
      ' (the database and tohyee.env with its password). Installing Tohyee again picks it up. Delete that folder only if you no longer need the data.',
      mbInformation, MB_OK, IDOK);
end;
