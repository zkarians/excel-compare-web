import { useState, useEffect } from 'react';
import { X, Save, Trash2, Plus, FileText } from 'lucide-react';

interface PopManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface PopWeight {
  cntr_no: string;
  weight: number;
  memo: string;
  created_at?: string;
}

export function PopManagerModal({ isOpen, onClose }: PopManagerModalProps) {
  const [weights, setWeights] = useState<PopWeight[]>([]);
  const [cntrNo, setCntrNo] = useState('');
  const [weight, setWeight] = useState('');
  const [memo, setMemo] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadPopWeights();
    }
  }, [isOpen]);

  const loadPopWeights = async () => {
    try {
      const res = await fetch('http://localhost:3000/api/pop-weights');
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.data)) {
          setWeights(data.data);
          return;
        }
      }
    } catch (err) {
      console.error('Failed to load POP weights', err);
    }
    
    // Mock for UI test
    setWeights([
      { cntr_no: 'TRHU1234567', weight: 15200.5, memo: 'Test POP Data 1', created_at: new Date().toISOString() }
    ]);
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cntrNo.trim() || !weight.trim()) return;

    try {
      const payload = {
        cntrNo: cntrNo.toUpperCase().trim(),
        weight: parseFloat(weight),
        memo: memo.trim()
      };

      const res = await fetch('http://localhost:3000/api/pop-weights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (res.ok) {
        loadPopWeights();
        setCntrNo('');
        setWeight('');
        setMemo('');
      } else {
        alert('저장 실패');
      }
    } catch (err) {
      console.error(err);
      alert('오류 발생');
    }
  };

  const handleDelete = async (cntr_no: string) => {
    if (!confirm(`'${cntr_no}' POP 중량 데이터를 삭제하시겠습니까?`)) return;

    try {
      const res = await fetch(`http://localhost:3000/api/pop-weights/${encodeURIComponent(cntr_no)}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        loadPopWeights();
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b bg-slate-50 shrink-0">
          <h2 className="text-xl font-bold text-orange-600 flex items-center gap-2">
            <span className="text-xl">⚖️</span> 계근대 (POP) 중량 연동 관리
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 flex flex-col flex-1 overflow-hidden bg-slate-50">
          <form onSubmit={handleAdd} className="mb-6 bg-white p-4 rounded-xl border shadow-sm flex items-end gap-3 shrink-0">
            <div className="flex-1">
              <label className="block text-xs font-bold text-slate-600 mb-1">컨테이너 번호</label>
              <input 
                type="text" 
                value={cntrNo}
                onChange={(e) => setCntrNo(e.target.value)}
                placeholder="ABCD1234567"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded focus:border-orange-500 focus:ring-1 focus:ring-orange-500 uppercase font-bold"
                required
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-bold text-slate-600 mb-1">실제 중량 (kg)</label>
              <input 
                type="number" 
                step="0.01"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                placeholder="예: 18500"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
                required
              />
            </div>
            <div className="flex-[2]">
              <label className="block text-xs font-bold text-slate-600 mb-1">비고 / 메모</label>
              <input 
                type="text" 
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="메모 입력"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
              />
            </div>
            <button 
              type="submit"
              className="flex items-center gap-1 px-5 py-2 text-sm font-bold text-white bg-orange-500 rounded hover:bg-orange-600 shadow-sm h-[38px]"
            >
              <Plus className="w-4 h-4" /> 추가
            </button>
          </form>

          <div className="bg-white rounded-xl border shadow-sm flex-1 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b sticky top-0">
                <tr>
                  <th className="px-4 py-3 font-bold text-slate-600">컨테이너 번호</th>
                  <th className="px-4 py-3 font-bold text-slate-600">POP 중량 (kg)</th>
                  <th className="px-4 py-3 font-bold text-slate-600">메모</th>
                  <th className="px-4 py-3 font-bold text-slate-600">등록일시</th>
                  <th className="px-4 py-3 font-bold text-slate-600 w-24 text-center">관리</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {weights.map((row) => (
                  <tr key={row.cntr_no} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-bold text-slate-700">{row.cntr_no}</td>
                    <td className="px-4 py-3 font-bold text-orange-600">{row.weight.toLocaleString()}</td>
                    <td className="px-4 py-3 text-slate-500">{row.memo}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{row.created_at ? new Date(row.created_at).toLocaleString() : ''}</td>
                    <td className="px-4 py-3 text-center">
                      <button 
                        onClick={() => handleDelete(row.cntr_no)}
                        className="p-1 text-red-600 hover:bg-red-50 rounded"
                        title="삭제"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {weights.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-slate-500">
                      등록된 계근대 중량 데이터가 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
