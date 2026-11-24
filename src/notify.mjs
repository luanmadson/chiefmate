// Windows notifications (the toasts in the corner of the screen). Clicking one opens the app on the right section
// ("chiefmate:operations", registered by scripts/install.ps1) or the address given, such as a pull request.
import { spawn } from 'node:child_process';
import { recordNotification } from './store.mjs';

const xml = s =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Borrows Windows PowerShell's identity, so the notification shows up without installing anything.
const SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
  '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$x.LoadXml($env:CHIEFMATE_TOAST)',
  '$t = [Windows.UI.Notifications.ToastNotification]::new($x)',
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($t)",
].join('; ');

export function notify(title, text, target = 'chiefmate:operations') {
  recordNotification(title, text);
  if (process.platform !== 'win32') return;
  const toast = `<toast activationType="protocol" launch="${xml(target)}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(text)}</text></binding></visual></toast>`;
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT], {
    env: { ...process.env, CHIEFMATE_TOAST: toast },
    windowsHide: true,
    stdio: 'ignore',
  });
  ps.on('error', () => {});
}
