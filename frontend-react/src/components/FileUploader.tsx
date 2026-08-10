import { useState, useRef } from 'react';
import { type LucideIcon } from 'lucide-react';
import { parseOriginalExcel, parseDownloadExcel } from '../utils/excelParser';
import { useAppStore } from '../store';

interface FileUploaderProps {
  title: string;
  type: 'original' | 'download' | 'rework' | 'warehouse';
  icon: LucideIcon;
  colorClass: string; // e.g., 'indigo', 'sky', 'pink', 'emerald'
  required?: boolean;
}

export function FileUploader({ title, type, icon: Icon, colorClass, required = true }: FileUploaderProps) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [dirPath, setDirPath] = useState(() => {
    // 로컬 스토리지에서 이전 경로 불러오기
    const key = type === 'original' ? 'origDir' : (type === 'download' ? 'downDir' : (type === 'rework' ? 'reworkDir' : 'whDir'));
    return localStorage.getItem(key) || '';
  });
  const [recentFile, setRecentFile] = useState(() => {
    const key = type === 'original' ? 'lastOrigName' : (type === 'download' ? 'lastDownName' : (type === 'rework' ? 'lastReworkName' : 'lastWhName'));
    return localStorage.getItem(key) || '';
  });
  const [statusMsg, setStatusMsg] = useState('준비됨');
  const [statusColor, setStatusColor] = useState('text-slate-500');
  
  const setOriginalData = useAppStore(state => state.setOriginalData);
  const setDownloadData = useAppStore(state => state.setDownloadData);
  const setReworkData = useAppStore(state => state.setReworkData);
  const setWarehouseData = useAppStore(state => state.setWarehouseData);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 로컬 파일 객체로 파싱 (직접 선택)
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setIsParsing(true);
    setStatusMsg(`분석 중...`);
    setStatusColor('text-blue-500');

    try {
      const arrayBuffer = await file.arrayBuffer();
      let parsedData = [];
      
      if (type === 'original') {
        parsedData = await parseOriginalExcel(arrayBuffer, {}, ["직선적당일", "법인당일", "혼적당일"], 'original', { stopOnEmptyRow: false, legacyCntrDetection: false, includeExtraFields: true });
        setOriginalData(parsedData);
      } else if (type === 'rework') {
        parsedData = await parseOriginalExcel(arrayBuffer, {}, ["재작업당일"], 'rework', { stopOnEmptyRow: false, legacyCntrDetection: false, includeExtraFields: true });
        setReworkData(parsedData);
      } else if (type === 'download') {
        parsedData = await parseDownloadExcel(arrayBuffer, {});
        setDownloadData(parsedData);
      } else if (type === 'warehouse') {
        const formData = new FormData();
        formData.append('warehouseFile', file);
        const response = await fetch('http://localhost:3000/api/parse-warehouse-stock', { method: 'POST', body: formData });
        if (!response.ok) throw new Error('서버 응답 오류');
        const data = await response.json();
        if (data.success) {
          parsedData = data.data || [];
          setWarehouseData(parsedData);
        } else {
          throw new Error(data.message || '파싱 실패');
        }
      }
      
      setStatusMsg(`분석 완료 (${file.name})`);
      setStatusColor('text-emerald-600');
    } catch (err: any) {
      console.error(`❌ ${title} 파일 읽기 실패:`, err);
      setStatusMsg(`실패: ${err.message}`);
      setStatusColor('text-red-500');
    } finally {
      setIsParsing(false);
    }
  };

  // 최신 파일 로드 API 호출
  const handleLoadLatest = async (overridePath?: string) => {
    const pathToLoad = overridePath || dirPath;
    if (!pathToLoad) {
      alert("경로를 입력해주세요.");
      return;
    }
    
    // 로컬 스토리지에 경로 저장
    const key = type === 'original' ? 'origDir' : (type === 'download' ? 'downDir' : (type === 'rework' ? 'reworkDir' : 'whDir'));
    localStorage.setItem(key, pathToLoad);

    setIsParsing(true);
    setStatusMsg(`최신 파일 탐색 중...`);
    setStatusColor('text-blue-500');

    try {
      const response = await fetch(`http://localhost:3000/api/load-latest-from-dir?dirPath=${encodeURIComponent(pathToLoad)}&t=${Date.now()}`);
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || '파일을 찾을 수 없습니다.');
      }

      const result = await response.json();
      if (!result.success) throw new Error(result.message);

      // base64 to File object
      const binaryStr = atob(result.base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const file = new File([blob], result.fileName, { type: blob.type });

      // 내부적으로 handleFileChange와 비슷한 과정 수행
      const dt = new DataTransfer();
      dt.items.add(file);
      if (fileInputRef.current) {
        fileInputRef.current.files = dt.files;
        // 수동으로 이벤트 핸들러 호출
        handleFileChange({ target: { files: dt.files } } as any);
      }
      
      const rKey = type === 'original' ? 'lastOrigName' : (type === 'download' ? 'lastDownName' : (type === 'rework' ? 'lastReworkName' : 'lastWhName'));
      const pKey = type === 'original' ? 'pathOrig' : (type === 'download' ? 'pathDown' : (type === 'rework' ? 'pathRework' : 'pathWh'));
      localStorage.setItem(rKey, result.fileName);
      localStorage.setItem(pKey, result.fullPath);
      setRecentFile(result.fileName);
      setFileName(result.fileName);
      
    } catch (err: any) {
      console.error(err);
      setStatusMsg(`실패: ${err.message}`);
      setStatusColor('text-red-500');
      setIsParsing(false);
    }
  };

  // 탐색기 열기 (네이티브 파일 선택 창)
  const handleOpenExplorer = async () => {
    try {
      if ((window as any).electronAPI && (window as any).electronAPI.selectFile) {
        const lastDir = localStorage.getItem(type + 'Dir') || undefined;
        const filePath = await (window as any).electronAPI.selectFile(type, lastDir);
        if (filePath) {
          setDirPath(filePath);
          
          // 폴더 경로만 추출해서 저장 (다음 번 열 때 사용)
          const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
          const folder = lastSlash !== -1 ? filePath.substring(0, lastSlash) : filePath;
          localStorage.setItem(type + 'Dir', folder);
          
          // 파일 즉시 로드
          handleLoadLatest(filePath);
        }
      } else {
        // 일렉트론 환경이 아니면 기존 파일 입력창 클릭 이벤트 발생
        fileInputRef.current?.click();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // 최근 항목 불러오기
  const handleLoadRecent = async () => {
    if (!recentFile) return;
    const pKey = type === 'original' ? 'pathOrig' : (type === 'download' ? 'pathDown' : (type === 'rework' ? 'pathRework' : 'pathWh'));
    const filePath = localStorage.getItem(pKey);
    if (!filePath) {
      alert("최근 불러온 파일의 전체 경로를 찾을 수 없습니다.");
      return;
    }

    setIsParsing(true);
    setStatusMsg(`최근 파일 불러오는 중...`);
    setStatusColor('text-blue-500');

    try {
      const response = await fetch(`http://localhost:3000/api/load-file-raw?path=${encodeURIComponent(filePath)}&t=${Date.now()}`);
      if (!response.ok) throw new Error('파일을 찾을 수 없습니다.');
      
      const result = await response.json();
      if (!result.success) throw new Error(result.message);

      // base64 to File object
      const binaryStr = atob(result.base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const file = new File([blob], result.fileName, { type: blob.type });

      const dt = new DataTransfer();
      dt.items.add(file);
      if (fileInputRef.current) {
        fileInputRef.current.files = dt.files;
        handleFileChange({ target: { files: dt.files } } as any);
      }
    } catch (err: any) {
      console.error(err);
      setStatusMsg(`실패: ${err.message}`);
      setStatusColor('text-red-500');
      setIsParsing(false);
    }
  };

  const colors: Record<string, string> = {
    indigo: 'bg-indigo-500 text-indigo-600 bg-indigo-50 hover:bg-indigo-100 hover:border-indigo-200 file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100',
    sky: 'bg-sky-500 text-sky-600 bg-sky-50 hover:bg-sky-100 hover:border-sky-200 file:bg-sky-50 file:text-sky-700 hover:file:bg-sky-100',
    pink: 'bg-pink-500 text-pink-600 bg-pink-50 hover:bg-pink-100 hover:border-pink-200 file:bg-pink-50 file:text-pink-700 hover:file:bg-pink-100',
    emerald: 'bg-emerald-500 text-emerald-600 bg-emerald-50 hover:bg-emerald-100 hover:border-emerald-200 file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100'
  };

  return (
    <div className={`bg-white rounded-xl p-5 border shadow-sm flex flex-col gap-4 relative overflow-hidden group transition-colors ${colors[colorClass].split(' ')[4]}`}>
      <div className={`absolute top-0 left-0 w-1 h-full ${colors[colorClass].split(' ')[0]}`}></div>
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-slate-700 flex items-center gap-2">
          <div className={`w-8 h-8 rounded-lg ${colors[colorClass].split(' ')[2]} ${colors[colorClass].split(' ')[1]} flex items-center justify-center`}>
            <Icon className="w-4 h-4" />
          </div>
          {title}
        </h3>
        <button 
          onClick={handleLoadLatest}
          disabled={isParsing}
          className={`px-3 py-1.5 text-xs font-bold text-white rounded-md transition-colors shadow-sm whitespace-nowrap
            ${colorClass === 'indigo' ? 'bg-blue-500 hover:bg-blue-600' : ''}
            ${colorClass === 'sky' ? 'bg-blue-500 hover:bg-blue-600' : ''}
            ${colorClass === 'pink' ? 'bg-pink-500 hover:bg-pink-600' : ''}
            ${colorClass === 'emerald' ? 'bg-emerald-500 hover:bg-emerald-600' : ''}
            disabled:opacity-50`}
        >
          <span className="flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
            최신 파일 로드
          </span>
        </button>
      </div>

      <div className="flex flex-col gap-3 relative z-10">
        {/* Path Input Area */}
        <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg p-1.5 focus-within:border-indigo-300 focus-within:ring-1 focus-within:ring-indigo-300">
          <input 
            type="text" 
            value={dirPath}
            onChange={(e) => setDirPath(e.target.value)}
            placeholder="예: Z:\2026년\07월..."
            className="flex-1 bg-transparent border-none text-xs text-slate-600 px-2 outline-none w-full"
          />
          <button 
            onClick={handleOpenExplorer}
            className="px-3 py-1 text-xs bg-white border border-slate-300 rounded text-slate-700 hover:bg-slate-100 font-medium flex items-center gap-1 shadow-sm whitespace-nowrap"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
            탐색기
          </button>
        </div>

        {/* Direct File Input Area */}
        <div className="flex items-center gap-2 pl-1">
          <span className="text-xs font-semibold text-slate-500">직접:</span>
          <input 
            type="file" 
            accept=".xlsx,.xls"
            ref={fileInputRef}
            onChange={handleFileChange}
            disabled={isParsing}
            className={`text-xs text-slate-500 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold cursor-pointer file:bg-slate-100 file:text-slate-600 hover:file:bg-slate-200 w-full`} 
          />
        </div>
        
        {isParsing && (
          <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-20 rounded-lg">
            <span className="text-sm font-bold animate-pulse text-indigo-600">데이터 처리 중...</span>
          </div>
        )}
        
        {/* Status Area */}
        <div className="flex items-center justify-between mt-1 pt-3 border-t border-slate-100 border-dashed">
          <div className="flex items-center gap-1.5 truncate max-w-[55%]">
            <svg className={`w-3.5 h-3.5 ${statusColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
            <span className={`text-xs font-bold truncate ${statusColor}`}>
              상태: {statusMsg}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-400 truncate max-w-[80px]" title={recentFile}>
              최근: {recentFile ? recentFile : '없음'}
            </span>
            <button 
              onClick={handleLoadRecent}
              disabled={!recentFile}
              className="px-2 py-1 text-[10px] font-bold border border-slate-200 rounded text-slate-600 hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed bg-white whitespace-nowrap"
            >
              불러오기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
