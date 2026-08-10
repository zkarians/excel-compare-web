import { useState, useEffect } from 'react';
import { X, Save, Plus, Edit2, Trash2 } from 'lucide-react';

interface CarrierMappingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const defaultMap: Record<string, string[]> = {
  "MSK": ["머스크", "MAERSK", "MSK", "한국머스크", "KR055242", "MAEU", "MSKU"],
  "HMM": ["현대", "HYUNDAI", "HMM", "현대상선", "HMMU"],
  "ONE": ["ONE", "오션", "OCEAN", "ONEU", "오션네트워크익스프레스코리아"],
  "CQN": ["CQN", "천경", "CKLINE", "CKLU"],
  "CMA": ["CMA", "CGM", "씨엠에이", "CMDU"],
  "MSC": ["MSC", "엠에스씨", "MSCU", "엠에스씨코리아"],
  "COS": ["COSCO", "COS", "코스코", "COSU"],
  "PIL": ["PIL", "피아이엘", "PCIU"],
  "YML": ["YML", "양밍", "YANGMING", "YMLU", "양밍한국"],
  "EMC": ["EVERGREEN", "EVG", "장금", "EVER", "EGLV", "EMC", "(주)에버그린코리아", "에버그린코리아", "SINOKOR", "SNKO"],
  "OOL": ["OOCL", "오오씨엘", "OOL", "(주)오오씨엘코리아", "오오씨엘코리아", "OOCU"],
  "ESL": ["ESL", "에미레이트", "EMIRATES", "에미레이트쉬핑코리아"],
  "FEO": ["FEO", "동해해운", "동해", "FESCO", "FESU"],
  "SML": ["SML", "SM", "에스엠", "SMLU"],
  "HPL": ["HPL", "HAPAG", "하팍", "HLFU"],
  "ZIM": ["ZIM", "짐라인", "ZIMU"],
  "WSL": ["협운인터네셔널", "WSL", "협운"],
  "HLC": ["하파그로이드코리아", "하팍로이드", "HLC", "HLAG"],
  "SKR": ["장금상선", "SKR", "장금", "SINOKOR", "SNKO"],
  "DYS": ["동영해운", "DYS", "동영"],
  "KMD": ["고려해운", "고려", "KMD", "KMTC"],
  "IAL": ["인터아시아", "INTERASIA", "INTER ASIA", "IAL", "IAAU"],
  "TSL": ["TSLINE", "TSL", "덕상티에스라인즈", "덕상티에스"]
};

export function CarrierMappingModal({ isOpen, onClose }: CarrierMappingModalProps) {
  const [carrierMap, setCarrierMap] = useState<Record<string, string[]>>({});
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [inputCode, setInputCode] = useState('');
  const [inputNames, setInputNames] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadCarrierMap();
    }
  }, [isOpen]);

  const loadCarrierMap = async () => {
    try {
      const response = await fetch('http://localhost:3000/api/sync/carriers');
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.mapping && Object.keys(data.mapping).length > 0) {
          setCarrierMap(data.mapping);
          return;
        }
      }
    } catch (err) {
      console.error('Failed to load from DB, trying local storage', err);
    }

    const savedMap = localStorage.getItem('carrierMapPrefs');
    if (savedMap) {
      const parsed = JSON.parse(savedMap);
      setCarrierMap(parsed);
    } else {
      setCarrierMap(defaultMap);
    }
  };

  const saveCarrierMap = async (newMap: Record<string, string[]>) => {
    setCarrierMap(newMap);
    localStorage.setItem('carrierMapPrefs', JSON.stringify(newMap));
    try {
      await fetch('http://localhost:3000/api/sync/carriers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping: newMap })
      });
    } catch (err) {
      console.error('Failed to save to DB', err);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputCode.trim() || !inputNames.trim()) return;

    const code = inputCode.toUpperCase().trim();
    const names = inputNames.split(',').map(s => s.trim()).filter(s => s);

    const newMap = { ...carrierMap };
    
    if (editingCode && editingCode !== code) {
      delete newMap[editingCode];
    }
    
    newMap[code] = names;
    saveCarrierMap(newMap);
    
    setInputCode('');
    setInputNames('');
    setEditingCode(null);
  };

  const handleEdit = (code: string, names: string[]) => {
    setEditingCode(code);
    setInputCode(code);
    setInputNames(names.join(', '));
  };

  const handleDelete = (code: string) => {
    if (confirm(`'${code}' 선사 매핑을 삭제하시겠습니까?`)) {
      const newMap = { ...carrierMap };
      delete newMap[code];
      saveCarrierMap(newMap);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <span className="text-xl">⚙️</span> 선사/포워딩 매핑 설정
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 bg-slate-50">
          <form onSubmit={handleSubmit} className="mb-6 bg-white p-4 rounded-xl border shadow-sm flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs font-bold text-slate-600 mb-1">표준 선사 코드 (예: MSK)</label>
              <input 
                type="text" 
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value)}
                placeholder="표준 코드"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 uppercase font-bold"
                required
              />
            </div>
            <div className="flex-[3]">
              <label className="block text-xs font-bold text-slate-600 mb-1">동의어/매핑 이름 (쉼표 구분)</label>
              <input 
                type="text" 
                value={inputNames}
                onChange={(e) => setInputNames(e.target.value)}
                placeholder="머스크, MAERSK, MAEU..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                required
              />
            </div>
            <div className="flex gap-2">
              {editingCode && (
                <button 
                  type="button"
                  onClick={() => { setEditingCode(null); setInputCode(''); setInputNames(''); }}
                  className="px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 rounded hover:bg-slate-200"
                >
                  취소
                </button>
              )}
              <button 
                type="submit"
                className="flex items-center gap-1 px-5 py-2 text-sm font-bold text-white bg-indigo-600 rounded hover:bg-indigo-700 shadow-sm"
              >
                {editingCode ? <Save className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                {editingCode ? '수정' : '추가'}
              </button>
            </div>
          </form>

          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b">
                <tr>
                  <th className="px-4 py-3 font-bold text-slate-600 w-1/4">표준 코드</th>
                  <th className="px-4 py-3 font-bold text-slate-600">동의어 매핑</th>
                  <th className="px-4 py-3 font-bold text-slate-600 w-24 text-center">관리</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {Object.entries(carrierMap).map(([code, names]) => (
                  <tr key={code} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-bold text-slate-700">{code}</td>
                    <td className="px-4 py-3 text-slate-500">{names.join(', ')}</td>
                    <td className="px-4 py-3 text-center flex justify-center gap-2">
                      <button 
                        type="button"
                        onClick={() => handleEdit(code, names)}
                        className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                        title="수정"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button 
                        type="button"
                        onClick={() => handleDelete(code)}
                        className="p-1 text-red-600 hover:bg-red-50 rounded"
                        title="삭제"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
