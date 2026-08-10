import { useState, useEffect } from 'react';
import { X, Save, Mail, History } from 'lucide-react';

interface MailSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MailSettingsModal({ isOpen, onClose }: MailSettingsModalProps) {
  const [smtpServer, setSmtpServer] = useState('');
  const [port, setPort] = useState('465');
  const [emailUser, setEmailUser] = useState('');
  const [emailPass, setEmailPass] = useState('');
  const [ccList, setCcList] = useState('');
  const [template, setTemplate] = useState('수출 선적 서류 송부드립니다.');

  useEffect(() => {
    if (isOpen) {
      const stored = localStorage.getItem('mailSettings');
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          setSmtpServer(parsed.smtpServer || '');
          setPort(parsed.port || '465');
          setEmailUser(parsed.emailUser || '');
          setEmailPass(parsed.emailPass || '');
          setCcList(parsed.ccList || '');
          setTemplate(parsed.template || '수출 선적 서류 송부드립니다.');
        } catch (e) {
          console.error(e);
        }
      }
    }
  }, [isOpen]);

  const handleSave = () => {
    const settings = {
      smtpServer, port, emailUser, emailPass, ccList, template
    };
    localStorage.setItem('mailSettings', JSON.stringify(settings));
    alert('메일 설정이 저장되었습니다.');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-xl font-bold text-violet-700 flex items-center gap-2">
            <span className="text-xl">📧</span> 메일 및 발송 설정
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 bg-slate-50 space-y-4">
          <div className="bg-white p-4 rounded-xl border shadow-sm space-y-3">
            <h3 className="font-bold text-slate-700 flex items-center gap-2 border-b pb-2 mb-2">
              <Mail className="w-4 h-4 text-violet-500" /> SMTP 발신 서버 설정
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">SMTP 서버</label>
                <input 
                  type="text" 
                  value={smtpServer}
                  onChange={(e) => setSmtpServer(e.target.value)}
                  placeholder="smtp.gmail.com"
                  className="w-full px-3 py-2 text-sm border rounded focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">포트</label>
                <input 
                  type="text" 
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="465"
                  className="w-full px-3 py-2 text-sm border rounded focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">이메일 계정</label>
                <input 
                  type="email" 
                  value={emailUser}
                  onChange={(e) => setEmailUser(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full px-3 py-2 text-sm border rounded focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">비밀번호(앱 비밀번호)</label>
                <input 
                  type="password" 
                  value={emailPass}
                  onChange={(e) => setEmailPass(e.target.value)}
                  placeholder="********"
                  className="w-full px-3 py-2 text-sm border rounded focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                />
              </div>
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border shadow-sm space-y-3">
            <h3 className="font-bold text-slate-700 border-b pb-2 mb-2">발송 옵션</h3>
            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1">참조(CC) 목록 (쉼표로 구분)</label>
              <input 
                type="text" 
                value={ccList}
                onChange={(e) => setCcList(e.target.value)}
                placeholder="cc1@test.com, cc2@test.com"
                className="w-full px-3 py-2 text-sm border rounded focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1">기본 메일 내용 템플릿</label>
              <textarea 
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 text-sm border rounded focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t bg-white gap-3">
          <button 
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
            onClick={() => alert("메일 발송 히스토리 조회 기능 준비 중입니다.")}
          >
            <History className="w-4 h-4" />
            발송 내역 조회
          </button>
          
          <div className="flex gap-2">
            <button 
              onClick={onClose}
              className="px-6 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
            >
              취소
            </button>
            <button 
              onClick={handleSave}
              className="flex items-center gap-2 px-6 py-2 text-sm font-bold text-white bg-violet-600 rounded-lg hover:bg-violet-700 transition-colors"
            >
              <Save className="w-4 h-4" />
              저장
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
