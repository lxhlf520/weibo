/**
 * 邮件通知 - 网易163邮箱 SMTP（通过网易邮箱大师中转）
 * 环境变量：
 *   SMTP_USER      - 163 邮箱地址（如 yourname@163.com）
 *   SMTP_AUTH_CODE - 163 邮箱授权码（不是登录密码）
 *   TO_EMAIL       - 告警收件邮箱
 * 获取授权码：登录 163 邮箱 → 设置 → POP3/SMTP/IMAP → 开启并生成授权码
 */
import nodemailer from 'nodemailer';

const TO_EMAIL = process.env.TO_EMAIL || '';
const SMTP_USER = process.env.SMTP_USER || '';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    const authCode = process.env.SMTP_AUTH_CODE || '';
    transporter = nodemailer.createTransport({
      host: 'smtp.163.com',
      port: 465,
      secure: true,
      auth: {
        user: SMTP_USER,
        pass: authCode,
      },
    });
  }
  return transporter;
}

/** 记录最近发送的邮件 key，避免重复发送（30分钟内同一 key 不重发） */
const recentAlerts = new Map<string, number>();

function dedupKey(key: string): boolean {
  const now = Date.now();
  const last = recentAlerts.get(key);
  if (last && now - last < 30 * 60 * 1000) return false; // 30分钟内发过
  recentAlerts.set(key, now);
  // 清理过期记录
  for (const [k, t] of recentAlerts) if (now - t > 60 * 60 * 1000) recentAlerts.delete(k);
  return true;
}

export async function sendAlertEmail(subject: string, body: string): Promise<boolean> {
  if (!SMTP_USER || !process.env.SMTP_AUTH_CODE || !TO_EMAIL) {
    console.log(`[邮件] 未设置 SMTP_USER / SMTP_AUTH_CODE / TO_EMAIL 环境变量，跳过发送: ${subject}`);
    return false;
  }
  try {
    const t = getTransporter();
    await t.sendMail({
      from: `"实验平台告警" <${SMTP_USER}>`,
      to: TO_EMAIL,
      subject: `[实验平台] ${subject}`,
      text: body,
      html: body.replace(/\n/g, '<br>'),
    });
    console.log(`[邮件] 已发送: ${subject}`);
    return true;
  } catch (e: any) {
    console.error(`[邮件] 发送失败: ${e.message}`);
    return false;
  }
}

/**
 * Cookie 过期告警（带去重）
 * @param platform - 'weibo' | 'twitter'
 * @param nickname - 账号昵称
 * @param reason - 过期原因
 */
export async function notifyCookieExpired(
  platform: string,
  nickname: string,
  reason: string,
): Promise<void> {
  const key = `${platform}:${nickname}`;
  if (!dedupKey(key)) return;

  const subject = `${platform} 账号 Cookie 过期: ${nickname}`;
  const body = [
    `平台: ${platform}`,
    `账号: ${nickname}`,
    `原因: ${reason}`,
    `时间: ${new Date().toLocaleString('zh-CN')}`,
    ``,
    `请尽快重新扫码登录该账号以恢复实验。`,
  ].join('\n');

  await sendAlertEmail(subject, body);
}

/**
 * 批量账号 cookie 过期告警
 */
export async function notifyBatchCookieExpired(
  platform: string,
  accounts: string[],
  reason: string,
): Promise<void> {
  const key = `${platform}:batch:${accounts.length}`;
  if (!dedupKey(key) && accounts.length <= 1) return;

  const subject = `${platform} 批量 Cookie 过期: ${accounts.length} 个账号`;
  const body = [
    `平台: ${platform}`,
    `过期账号数: ${accounts.length}`,
    `账号列表: ${accounts.join(', ')}`,
    `原因: ${reason}`,
    `时间: ${new Date().toLocaleString('zh-CN')}`,
    ``,
    `请尽快重新扫码登录这些账号以恢复实验。`,
  ].join('\n');

  await sendAlertEmail(subject, body);
}

/**
 * 系统异常告警（通用）
 */
export async function notifySystemAlert(
  platform: string,
  title: string,
  detail: string,
): Promise<void> {
  const key = `${platform}:system:${title}`;
  if (!dedupKey(key)) return;

  const subject = `${platform} 系统告警: ${title}`;
  const body = [
    `平台: ${platform}`,
    `告警: ${title}`,
    `详情: ${detail}`,
    `时间: ${new Date().toLocaleString('zh-CN')}`,
  ].join('\n');

  await sendAlertEmail(subject, body);
}
