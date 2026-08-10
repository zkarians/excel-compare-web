import { useState, useRef, useEffect } from 'react';
import { Database, Trash2, Upload, Eraser } from 'lucide-react';

export function ProductMaster() {
  const [masterCount, setMasterCount] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchMasterCount = async () => {
    try {
      const res = await fetch('http://localhost:3000/api/db-stats');
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.stats) {
          setMasterCount(parseInt(data.stats.total_master) || 0);
        }
      }
    } catch (err) {
      console.error('DB 통계 조회 실패', err);
    }
  };

  useEffect(() => {
    fetchMasterCount();
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!confirm(`'${file.name}' 파일의 제품 데이터를 마스터 DB에 업데이트(Upsert) 하시겠습니까?`)) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsUploading(true);
    const formData = new FormData();
    formData.append('masterFile', file);

    try {
      const response = await fetch('http://localhost:3000/api/upload-master', {
        method: 'POST',
        body: formData
      });
      const data = await response.json();
      if (data.success) {
        alert(`제품 마스터 업데이트 성공!\n업데이트 건수: ${data.data?.length || 0}건`);
        fetchMasterCount();
      } else {
        alert(`업데이트 실패: ${data.message}`);
      }
    } catch (err: any) {
      alert(`업데이트 중 오류 발생: ${err.message}`);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleClean = async () => {
    if (!confirm('최근 30일간 사용되지 않은 제품 마스터 데이터를 정리하시겠습니까? (삭제 후 복구 불가)')) return;
    try {
      const response = await fetch('http://localhost:3000/api/master-data/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 30 })
      });
      const data = await response.json();
      if (data.success) {
        alert(`정리 완료! ${data.deletedCount}건이 삭제되었습니다.`);
        fetchMasterCount();
      } else {
        alert(`정리 실패: ${data.message}`);
      }
    } catch (err: any) {
      alert(`오류: ${err.message}`);
    }
  };

  const handleReset = async () => {
    if (!confirm('⚠️ 정말로 모든 제품 마스터 데이터를 초기화하시겠습니까?\n이 작업은 되돌릴 수 없습니다.')) return;
    try {
      const response = await fetch('http://localhost:3000/api/master-data/reset', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        alert('모든 마스터 데이터가 초기화되었습니다.');
        setMasterCount(0);
      } else {
        alert(`초기화 실패: ${data.message}`);
      }
    } catch (err: any) {
      alert(`오류: ${err.message}`);
    }
  };

  return (
    <div className="bg-white rounded-xl p-5 border shadow-sm flex flex-col gap-4 relative overflow-hidden group transition-colors hover:border-slate-300">
      <div className="absolute top-0 left-0 w-1 h-full bg-slate-400"></div>
      
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-slate-700 flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center">
            <Database className="w-4 h-4" />
          </div>
          3. 제품 마스터 데이터 <span className="text-xs font-normal text-slate-400">(클라우드 DB 우선)</span>
        </h3>
        <span className="text-xs px-2 py-1 bg-blue-50 text-blue-600 rounded-md font-medium border border-blue-100 flex items-center gap-1 shadow-sm">
          <svg className="w-3 h-3 animate-pulse" fill="currentColor" viewBox="0 0 20 20"><path d="M5.5 13a3.5 3.5 0 01-.369-6.98 4 4 0 117.759-1.574 2.997 2.997 0 014.651 3.55 3.5 3.5 0 01-3.041 5H5.5z"></path></svg>
          실시간 연동 중
        </span>
      </div>

      <div className="text-xs text-slate-500 flex flex-col gap-1.5 mb-1">
        <p className="flex items-center gap-1.5 font-medium">
          <Database className="w-3 h-3" />
          제품 중량 및 CBM 정보를 클라우드 데이터베이스에서 실시간으로 불러옵니다.
        </p>
      </div>

      {/* Upload Box */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-col gap-2 relative">
        <p className="text-xs font-bold text-slate-600 mb-1">신규 제품 등록 및 기존 정보 수정:</p>
        <div className="flex items-center gap-2">
          <input 
            type="file" 
            accept=".xlsx,.xls"
            ref={fileInputRef}
            onChange={handleFileUpload}
            disabled={isUploading}
            className="flex-1 text-xs text-slate-500 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold cursor-pointer file:bg-white file:text-slate-600 file:border file:border-slate-300 hover:file:bg-slate-50 w-full" 
          />
          <button 
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="px-3 py-1.5 text-xs font-bold text-indigo-600 bg-indigo-50 border border-indigo-200 rounded hover:bg-indigo-100 flex items-center gap-1 shadow-sm whitespace-nowrap disabled:opacity-50"
          >
            <Upload className="w-3 h-3" />
            일괄 업로드 (Upsert)
          </button>
        </div>
        <p className="text-[10px] text-slate-400 mt-1">* 동일 이름 제품은 업데이트, 새 제품은 추가됩니다.</p>
        
        {isUploading && (
          <div className="absolute inset-0 bg-white/80 flex items-center justify-center z-10 rounded-lg">
            <span className="text-xs font-bold animate-pulse text-indigo-600">데이터베이스 업데이트 중...</span>
          </div>
        )}
      </div>

      {/* Status & Actions */}
      <div className="flex items-center justify-between mt-2 pt-3 border-t border-slate-100">
        <div className="flex items-center gap-1.5 text-sm font-bold text-slate-700">
          <Database className="w-4 h-4 text-blue-500" />
          상태: 클라우드 DB 연동 완료 ({masterCount.toLocaleString()}건)
        </div>
      </div>
      
      <div className="flex items-center justify-between bg-slate-50 border border-slate-100 border-dashed rounded p-2 mt-1">
        <span className="text-xs text-slate-500 flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
          대량 DB 관리 (20만건+):
        </span>
        <div className="flex gap-2">
          <button 
            onClick={handleClean}
            className="px-2 py-1 text-[10px] font-bold text-slate-600 bg-white border border-slate-300 rounded hover:bg-slate-100 flex items-center gap-1 shadow-sm"
          >
            <Eraser className="w-3 h-3" />
            미사용 데이터 정리
          </button>
          <button 
            onClick={handleReset}
            className="px-2 py-1 text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 rounded hover:bg-red-100 flex items-center gap-1 shadow-sm"
          >
            <Trash2 className="w-3 h-3" />
            전체 초기화
          </button>
        </div>
      </div>

    </div>
  );
}
