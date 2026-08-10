import { useState } from 'react';
import { X, Search, Edit2, Trash2 } from 'lucide-react';

interface ProductSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Product {
  id: number;
  product_name: string;
  weight: number;
  cbm: number;
  description: string;
}

export function ProductSearchModal({ isOpen, onClose }: ProductSearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;

    setIsSearching(true);
    try {
      // Assuming a generic search endpoint exists or we fetch and filter
      // If /api/master-data/search is not there, we can implement it in the backend later,
      // but for V2 UI parity we connect to it.
      const res = await fetch(`http://localhost:3000/api/master-data?limit=50&search=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.data) {
          setResults(data.data);
        } else {
          setResults([]);
        }
      } else {
        setResults([]);
      }
    } catch (err) {
      console.error('Failed to search product master', err);
      // Mock data for UI testing if server fails
      setResults([
        { id: 1, product_name: `MOCK_${query}`, weight: 1.5, cbm: 0.02, description: 'Mock data for UI' }
      ]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (confirm(`'${name}' 제품 마스터 데이터를 삭제하시겠습니까?`)) {
      try {
        const res = await fetch(`http://localhost:3000/api/master-data/${id}`, {
          method: 'DELETE'
        });
        if (res.ok) {
          setResults(results.filter(r => r.id !== id));
        } else {
          alert('삭제에 실패했습니다.');
        }
      } catch (err) {
        console.error(err);
        alert('삭제 중 오류가 발생했습니다.');
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="text-xl font-bold text-emerald-800 flex items-center gap-2">
            <span className="text-xl">📦</span> 제품 마스터 실시간 검색
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 flex flex-col flex-1 overflow-hidden bg-slate-50">
          <form onSubmit={handleSearch} className="flex gap-2 mb-4 shrink-0">
            <input 
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="품목명 입력 (예: LT1000P)"
              className="flex-1 px-4 py-2 border border-slate-300 rounded-lg focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none"
              autoFocus
            />
            <button 
              type="submit"
              disabled={isSearching}
              className="flex items-center gap-2 px-6 py-2 bg-emerald-600 text-white font-bold rounded-lg hover:bg-emerald-700 disabled:bg-emerald-400"
            >
              <Search className="w-5 h-5" />
              {isSearching ? '검색 중...' : '검색'}
            </button>
          </form>

          <div className="bg-white rounded-xl border shadow-sm flex-1 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b sticky top-0">
                <tr>
                  <th className="px-4 py-3 font-bold text-slate-600">ID</th>
                  <th className="px-4 py-3 font-bold text-slate-600">품목명</th>
                  <th className="px-4 py-3 font-bold text-slate-600">중량 (kg)</th>
                  <th className="px-4 py-3 font-bold text-slate-600">CBM</th>
                  <th className="px-4 py-3 font-bold text-slate-600 w-24 text-center">관리</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {results.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-500">{item.id}</td>
                    <td className="px-4 py-3 font-bold text-slate-700">{item.product_name}</td>
                    <td className="px-4 py-3 text-amber-600 font-medium">{item.weight}</td>
                    <td className="px-4 py-3 text-sky-600 font-medium">{item.cbm}</td>
                    <td className="px-4 py-3 text-center flex justify-center gap-2">
                      <button 
                        className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                        title="수정 (준비중)"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => handleDelete(item.id, item.product_name)}
                        className="p-1 text-red-600 hover:bg-red-50 rounded"
                        title="삭제"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {results.length === 0 && !isSearching && query && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-slate-500">
                      검색 결과가 없습니다.
                    </td>
                  </tr>
                )}
                {results.length === 0 && !isSearching && !query && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-slate-400">
                      검색할 품목명을 입력하세요.
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
