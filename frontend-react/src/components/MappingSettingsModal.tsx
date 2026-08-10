import { useState, useEffect } from 'react';
import { X, Save, RefreshCw } from 'lucide-react';

interface MappingSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const standardFields = [
  { id: 'jobName', name: '[원본] 작업명', defaultCol: 'A' },
  { id: 'dest', name: '[원본] 목적지', defaultCol: 'E' },
  { id: 'prodType', name: '[원본] 등급(제품구분)', defaultCol: 'G' },
  { id: 'prodName', name: '[원본/전산] 품목명', defaultCol: 'I' },
  { id: 'qty', name: '[원본] 수량', defaultCol: 'J' },
  { id: 'cntrType', name: '[원본/전산] 규격(컨테이너)', defaultCol: 'N' },
  { id: 'carrier', name: '[원본] 선사', defaultCol: 'O' },
  { id: 'eta', name: '[원본] ETA', defaultCol: 'P' },
  { id: 'etd', name: '[원본] ETD', defaultCol: 'Q' },
  { id: 'remark', name: '[원본/전산] 비고', defaultCol: 'R' },
  { id: 'cntrNo', name: '[원본/전산] 컨테이너 번호', defaultCol: 'T' },
  { id: 'dl_division', name: '[전산] 사업부 (열)', defaultCol: 'A' },
  { id: 'dl_loadType', name: '[전산] 작업구분 (열)', defaultCol: 'B' },
  { id: 'dl_status', name: '[전산] 상태 (열)', defaultCol: 'D' },
  { id: 'dl_oqc', name: '[전산] OQC상태 (열)', defaultCol: 'F' },
  { id: 'dl_pendingQty', name: '[전산] 보류수량 (열)', defaultCol: 'G' },
  { id: 'dl_planQty', name: '[전산] 계획수량 (열)', defaultCol: 'J' },
  { id: 'dl_loadQty', name: '[전산] 적재수량 (열)', defaultCol: 'K' },
  { id: 'dl_volume', name: '[전산] CBM (열)', defaultCol: 'L' },
  { id: 'dl_weight', name: '[전산] 중량 (열)', defaultCol: 'M' },
  { id: 'dl_remainQty', name: '[전산] 잔여수량 (열)', defaultCol: 'O' },
  { id: 'dl_sealNo', name: '[전산] 씰번호 (열)', defaultCol: 'Q' },
  { id: 'dl_carrierCode', name: '[전산] 선사코드 (열)', defaultCol: 'S' },
  { id: 'dl_carrierName', name: '[전산] 선사명 (열)', defaultCol: 'T' },
  { id: 'dl_truckCode', name: '[전산] 트럭코드 (열)', defaultCol: 'W' },
  { id: 'dl_truckName', name: '[전산] 트럭명 (열)', defaultCol: 'X' },
  { id: 'dl_port', name: '[전산] 상차지 (열)', defaultCol: 'AA' },
  { id: 'dl_dest', name: '[전산] 도착지 (열)', defaultCol: 'AB' },
  { id: 'dl_loadPlanNo', name: '[전산] 작업지시번호 (열)', defaultCol: 'AE' },
  { id: 'dl_packingQty', name: '[전산] 포장수량 (열)', defaultCol: 'BM' },
];

export function MappingSettingsModal({ isOpen, onClose }: MappingSettingsModalProps) {
  const [mapping, setMapping] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen) {
      loadMapping();
    }
  }, [isOpen]);

  const loadMapping = () => {
    try {
      const stored = localStorage.getItem('mappingProfiles');
      if (stored) {
        const profiles = JSON.parse(stored);
        const activeId = localStorage.getItem('activeMappingProfileId') || 'default';
        if (profiles[activeId]) {
          setMapping(profiles[activeId].mapping);
          return;
        }
      }
    } catch (err) {
      console.error('Failed to load mapping profile', err);
    }
    
    // Default mapping fallback
    const defaultMapping: Record<string, string> = {};
    standardFields.forEach(f => {
      defaultMapping[f.id] = f.defaultCol;
    });
    setMapping(defaultMapping);
  };

  const saveMapping = () => {
    try {
      let profiles: any = {};
      const stored = localStorage.getItem('mappingProfiles');
      if (stored) profiles = JSON.parse(stored);

      const activeId = localStorage.getItem('activeMappingProfileId') || 'default';
      profiles[activeId] = {
        id: activeId,
        name: activeId === 'default' ? '기본 프로필' : activeId,
        mapping: mapping
      };

      localStorage.setItem('mappingProfiles', JSON.stringify(profiles));
      localStorage.setItem('activeMappingProfileId', activeId);
      alert('매핑 설정이 저장되었습니다.');
      onClose();
    } catch (err) {
      console.error('Failed to save mapping', err);
      alert('저장 중 오류가 발생했습니다.');
    }
  };

  const handleReset = () => {
    if (confirm('모든 매핑 설정을 기본값으로 초기화하시겠습니까?')) {
      const defaultMapping: Record<string, string> = {};
      standardFields.forEach(f => {
        defaultMapping[f.id] = f.defaultCol;
      });
      setMapping(defaultMapping);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
            엑셀 매핑 프로필 설정
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 bg-slate-50">
          <p className="text-sm text-slate-500 mb-6 bg-white p-3 rounded-lg border shadow-sm">
            전산 파일의 열(Column) 이름이 변경되더라도, 여기서 표준 필드와 연결(매핑)해주면 앱을 수정할 필요 없이 바로 사용할 수 있습니다. (예: A, B, C...)
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Original Fields */}
            <div className="bg-white p-4 rounded-xl border shadow-sm">
              <h3 className="font-bold text-slate-700 mb-4 pb-2 border-b flex items-center gap-2">
                <span className="w-6 h-6 rounded bg-indigo-100 text-indigo-600 flex items-center justify-center text-xs">1</span>
                원본 파일 필드 매핑
              </h3>
              <div className="space-y-3">
                {standardFields.filter(f => !f.id.startsWith('dl_')).map(field => (
                  <div key={field.id} className="flex items-center gap-3">
                    <label className="text-sm font-medium text-slate-600 flex-1">{field.name}</label>
                    <input 
                      type="text" 
                      value={mapping[field.id] || ''}
                      onChange={(e) => setMapping({...mapping, [field.id]: e.target.value.toUpperCase()})}
                      placeholder={field.defaultCol}
                      className="w-20 px-3 py-1.5 text-sm border border-slate-300 rounded focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none text-center font-bold text-slate-700 uppercase"
                      maxLength={3}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Download Fields */}
            <div className="bg-white p-4 rounded-xl border shadow-sm">
              <h3 className="font-bold text-slate-700 mb-4 pb-2 border-b flex items-center gap-2">
                <span className="w-6 h-6 rounded bg-sky-100 text-sky-600 flex items-center justify-center text-xs">2</span>
                전산 파일 필드 매핑
              </h3>
              <div className="space-y-3">
                {standardFields.filter(f => f.id.startsWith('dl_')).map(field => (
                  <div key={field.id} className="flex items-center gap-3">
                    <label className="text-sm font-medium text-slate-600 flex-1">{field.name}</label>
                    <input 
                      type="text" 
                      value={mapping[field.id] || ''}
                      onChange={(e) => setMapping({...mapping, [field.id]: e.target.value.toUpperCase()})}
                      placeholder={field.defaultCol}
                      className="w-20 px-3 py-1.5 text-sm border border-slate-300 rounded focus:border-sky-500 focus:ring-1 focus:ring-sky-500 outline-none text-center font-bold text-slate-700 uppercase"
                      maxLength={3}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t bg-white shrink-0">
          <button 
            onClick={handleReset}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            기본값 복원
          </button>
          <div className="flex gap-3">
            <button 
              onClick={onClose}
              className="px-6 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
            >
              취소
            </button>
            <button 
              onClick={saveMapping}
              className="flex items-center gap-2 px-6 py-2 text-sm font-bold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors"
            >
              <Save className="w-4 h-4" />
              매핑 저장
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
