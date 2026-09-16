'use client';

import { useState, useEffect, useCallback } from 'react';

interface WeiboAccount {
  id: number;
  weibo_uid: string;
  nickname: string;
  avatar: string;
  status: string;
  daily_comment_count: number;
  max_daily_comments: number;
  last_used_at: string | null;
  created_at: string;
  can_comment?: boolean;
  comment_checked_at?: string;
  comment_ban_reason?: string;
  cookie_checked_at?: string;
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<WeiboAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 扫码登录状态
  const [showQrModal, setShowQrModal] = useState(false);
  const [qrImageUrl, setQrImageUrl] = useState('');
  const [qrSessionId, setQrSessionId] = useState('');
  const [qrQrid, setQrQrid] = useState('');
  const [qrStatus, setQrStatus] = useState<string>('idle');
  const [qrMessage, setQrMessage] = useState('');

  const fetchAccounts = useCallback(async () => {
    try {
      const resp = await fetch('/api/accounts');
      const data = await resp.json();
      if (data.accounts) setAccounts(data.accounts);
    } catch {
      setError('获取账号列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // 获取二维码
  const fetchQrCode = async () => {
    setQrStatus('loading');
    try {
      const resp = await fetch('/api/weibo-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'qr_image' }),
      });
      const data = await resp.json();
      if (data.success) {
        setQrImageUrl(data.imageUrl);
        setQrSessionId(data.sessionId);
        setQrQrid(data.qrid);
        setQrStatus('waiting');
      } else {
        setError(data.error || '获取二维码失败');
        setQrStatus('error');
      }
    } catch {
      setError('网络错误');
      setQrStatus('error');
    }
  };

  // 轮询扫码状态
  useEffect(() => {
    if (qrStatus !== 'waiting' && qrStatus !== 'scanned') return;

    const poll = async () => {
      try {
        const resp = await fetch('/api/weibo-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'qr_check',
            qrid: qrQrid,
            sessionId: qrSessionId,
          }),
        });
        const data = await resp.json();

        if (data.status === 'scanned') {
          setQrStatus('scanned');
          setQrMessage('已扫码，请在手机上确认登录');
        } else if (data.status === 'confirmed') {
          setQrStatus('confirmed');
          setQrMessage(`登录成功！用户: ${data.nickname || data.uid}`);
          setTimeout(() => {
            setShowQrModal(false);
            fetchAccounts();
          }, 1500);
        } else if (data.status === 'expired') {
          setQrStatus('expired');
          setQrMessage('二维码已过期');
        }
      } catch {
        // 轮询失败继续重试
      }
    };

    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [qrStatus, qrQrid, qrSessionId, fetchAccounts]);

  const deleteAccount = async (id: number) => {
    if (!confirm('确定删除此账号？')) return;
    await fetch('/api/accounts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    fetchAccounts();
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'active': return 'bg-green-100 text-green-700';
      case 'expired': return 'bg-yellow-100 text-yellow-700';
      case 'banned': return 'bg-red-100 text-red-700';
      default: return 'bg-gray-100 text-gray-600';
    }
  };

  const toggleCanComment = async (acc: WeiboAccount) => {
    const newVal = acc.can_comment === false ? true : false;
    await fetch('/api/accounts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: acc.id, can_comment: newVal }),
    });
    fetchAccounts();
  };

  const formatTime = (iso: string | null | undefined): string => {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">微博账号管理</h1>
        <div className="flex gap-3">
          <button
            onClick={() => {
              setShowQrModal(true);
              setQrStatus('idle');
              setQrMessage('');
              fetchQrCode();
            }}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition"
          >
            + 扫码登录新账号
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg mb-4">{error}</div>
      )}

      {loading ? (
        <p className="text-gray-500">加载中...</p>
      ) : accounts.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl shadow-sm">
          <p className="text-gray-400 text-lg mb-4">暂无微博账号</p>
          <p className="text-gray-400 text-sm">点击右上角按钮扫码登录微博账号</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map((acc) => (
            <div key={acc.id} className="bg-white rounded-xl shadow-sm p-5">
              <div className="flex items-center gap-3 mb-3">
                {acc.avatar && (
                  <img src={acc.avatar} alt="" className="w-10 h-10 rounded-full" />
                )}
                <div>
                  <p className="font-medium">{acc.nickname || '未获取'}</p>
                  <p className="text-xs text-gray-400">UID: {acc.weibo_uid || '-'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 mb-3">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(acc.status)}`}>
                  {acc.status === 'active' ? '正常' : acc.status === 'expired' ? '过期' : acc.status === 'banned' ? '风控' : '异常'}
                </span>
                {acc.status === 'active' && (
                  acc.can_comment === false ? (
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700 cursor-pointer"
                      title={acc.comment_ban_reason || '评论已禁用'} onClick={() => toggleCanComment(acc)}>
                      🚫 禁评
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-green-50 text-green-600 cursor-pointer"
                      title="可评论" onClick={() => toggleCanComment(acc)}>
                      ✅ 可评
                    </span>
                  )
                )}
                <span className="text-xs text-gray-500">
                  今日: {acc.daily_comment_count}/{acc.max_daily_comments}
                </span>
              </div>
              {acc.comment_checked_at && (
                <div className="text-xs text-gray-400 mb-2">
                  权限检测: {formatTime(acc.comment_checked_at)}
                  {acc.comment_ban_reason && <span className="text-red-400 ml-2">({acc.comment_ban_reason})</span>}
                </div>
              )}
              {acc.cookie_checked_at && (
                <div className="text-xs text-gray-400 mb-2">
                  Cookie有效性: {formatTime(acc.cookie_checked_at)}
                </div>
              )}
              <div className="flex items-center justify-end mt-3 pt-3 border-t border-gray-100">
                <button
                  onClick={() => deleteAccount(acc.id)}
                  className="text-xs text-red-400 hover:text-red-600"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 扫码登录弹窗 */}
      {showQrModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-96 max-w-[90vw]">
            <h2 className="text-lg font-bold mb-4">微博扫码登录</h2>

            {qrStatus === 'loading' && (
              <div className="flex flex-col items-center py-8">
                <div className="animate-spin w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full mb-3" />
                <p className="text-gray-500">获取二维码...</p>
              </div>
            )}

            {(qrStatus === 'waiting' || qrStatus === 'scanned') && qrImageUrl && (
              <div className="flex flex-col items-center">
                <img src={qrImageUrl} alt="二维码" className="w-48 h-48 mb-3 border rounded-lg" />
                <p className="text-sm text-gray-600 mb-4">
                  {qrStatus === 'scanned' ? qrMessage : '请使用微博客户端扫描二维码'}
                </p>
              </div>
            )}

            {qrStatus === 'confirmed' && (
              <div className="flex flex-col items-center py-8">
                <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mb-3">
                  <span className="text-2xl text-green-600">&#10003;</span>
                </div>
                <p className="text-green-600 font-medium">{qrMessage}</p>
              </div>
            )}

            {qrStatus === 'expired' && (
              <div className="flex flex-col items-center py-8">
                <p className="text-yellow-600 mb-4">{qrMessage}</p>
                <button
                  onClick={fetchQrCode}
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
                >
                  刷新二维码
                </button>
              </div>
            )}

            {qrStatus === 'error' && (
              <div className="flex flex-col items-center py-8">
                <p className="text-red-600 mb-4">{error || '获取失败'}</p>
                <button onClick={fetchQrCode} className="text-blue-600 hover:underline">重试</button>
              </div>
            )}

            <button
              onClick={() => setShowQrModal(false)}
              className="w-full mt-4 text-gray-500 hover:text-gray-700 text-sm"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
