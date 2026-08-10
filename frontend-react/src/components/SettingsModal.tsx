import { useState, useEffect } from 'react';
import { X, Save, Database, Monitor, Cloud, Server } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [dbHost, setDbHost] = useState('');
  const [dbPort, setDbPort] = useState('5432');
  const [dbUser, setDbUser] = useState('');
  const [dbName, setDbName] = useState('');
  const [dbPass, setDbPass] = useState('');
  
  const [currentEnv, setCurrentEnv] = useState<'local' | 'cloud' | 'remote'>('cloud');

  useEffect(() => {
    if (isOpen) {
      const stored = localStorage.getItem('dbSettings');
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          setDbHost(parsed.host || '');
          setDbPort(parsed.port || '5432');
          setDbUser(parsed.user || '');
          setDbName(parsed.name || '');
          setDbPass(parsed.pass || '');
          setCurrentEnv(parsed.env || 'cloud');
        } catch (e) {
          console.error(e);
        }
      }
    }
  }, [isOpen]);

  const handleSave = () => {
    const settings = {
      host: dbHost,
      port: dbPort,
      user: dbUser,
      name: dbName,
      pass: dbPass,
      env: currentEnv
    };
    localStorage.setItem('dbSettings', JSON.stringify(settings));
    
    // Switch logic
    fetch('http://localhost:3000/api/settings/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    }).catch(console.error);

    alert('DB 설정이 저장되었습니다.');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-xl font-bold text-sky-700 flex items-center gap-2">
            <span className="text-xl">🗄️</span> DB 연결 및 데이터 동기화 설정
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 bg-slate-50 space-y-6">
          
          <div className="bg-sky-50 p-3 rounded-xl border border-sky-200 flex items-center gap-3 text-sm text-sky-800">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>현재 DB: <strong>{currentEnv === 'cloud' ? '클라우드 (Supabase)' : currentEnv === 'local' ? '로컬 PC' : dbHost}</strong></span>
            <span className="font-bold text-emerald-600">연결됨</span>
          </div>

          <div>
            <h3 className="font-bold text-slate-700 mb-3 border-b pb-2">DB 환경 전환</h3>
            <div className="flex gap-2">
              <button 
                onClick={() => setCurrentEnv('local')}
                className={`flex-1 py-3 rounded-lg font-bold flex items-center justify-center gap-2 transition-colors ${currentEnv === 'local' ? 'bg-emerald-500 text-white shadow-md' : 'bg-white border text-slate-600 hover:bg-slate-50'}`}
              >
                <Desktop className="w-4 h-4" /> 로컬 PC
              </button>
              <button 
                onClick={() => setCurrentEnv('cloud')}
                className={`flex-1 py-3 rounded-lg font-bold flex items-center justify-center gap-2 transition-colors ${currentEnv === 'cloud' ? 'bg-violet-600 text-white shadow-md' : 'bg-white border text-slate-600 hover:bg-slate-50'}`}
              >
                <Cloud className="w-4 h-4" /> 클라우드
              </button>
              <button 
                onClick={() => setCurrentEnv('remote')}
                className={`flex-1 py-3 rounded-lg font-bold flex items-center justify-center gap-2 transition-colors ${currentEnv === 'remote' ? 'bg-sky-600 text-white shadow-md' : 'bg-white border text-slate-600 hover:bg-slate-50'}`}
              >
                <Server className="w-4 h-4" /> 원격 PC DB
              </button>
            </div>
          </div>

          {currentEnv === 'remote' && (
            <div className="bg-white p-4 rounded-xl border shadow-sm space-y-4">
              <h3 className="font-bold text-slate-700 flex items-center gap-2 border-b pb-2">
                <Database className="w-4 h-4 text-sky-500" /> 원격 DB 접속 정보
              </h3>
              <div className="grid grid-cols-4 gap-4">
                <div className="col-span-3">
                  <label className="block text-xs font-bold text-slate-600 mb-1">호스트 (IP/DDNS)</label>
                  <input 
                    type="text" 
                    value={dbHost}
                    onChange={(e) => setDbHost(e.target.value)}
                    placeholder="예: db.example.com"
                    className="w-full px-3 py-2 text-sm border rounded focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                </div>
                <div className="col-span-1">
                  <label className="block text-xs font-bold text-slate-600 mb-1">포트</label>
                  <input 
                    type="text" 
                    value={dbPort}
                    onChange={(e) => setDbPort(e.target.value)}
                    placeholder="5432"
                    className="w-full px-3 py-2 text-sm border rounded focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-bold text-slate-600 mb-1">DB 이름</label>
                  <input 
                    type="text" 
                    value={dbName}
                    onChange={(e) => setDbName(e.target.value)}
                    placeholder="postgres"
                    className="w-full px-3 py-2 text-sm border rounded focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                </div>
                <div className="col-span-1">
                  <label className="block text-xs font-bold text-slate-600 mb-1">사용자</label>
                  <input 
                    type="text" 
                    value={dbUser}
                    onChange={(e) => setDbUser(e.target.value)}
                    placeholder="postgres"
                    className="w-full px-3 py-2 text-sm border rounded focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                </div>
                <div className="col-span-1">
                  <label className="block text-xs font-bold text-slate-600 mb-1">비밀번호</label>
                  <input 
                    type="password" 
                    value={dbPass}
                    onChange={(e) => setDbPass(e.target.value)}
                    className="w-full px-3 py-2 text-sm border rounded focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                </div>
              </div>
            </div>
          )}

        </div>

        <div className="flex items-center justify-end px-6 py-4 border-t bg-white gap-3">
          <button 
            onClick={onClose}
            className="px-6 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            취소
          </button>
          <button 
            onClick={handleSave}
            className="flex items-center gap-2 px-6 py-2 text-sm font-bold text-white bg-sky-600 rounded-lg hover:bg-sky-700 transition-colors"
          >
            <Save className="w-4 h-4" />
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
