import { useState } from 'react';
import { X, Search, Database } from 'lucide-react';

interface DBSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DBSearchModal({ isOpen, onClose }: DBSearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;

    setIsSearching(true);
    try {
      const res = await fetch(`http://localhost:3000/api/db/search?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.data || []);
      }
    } catch (err) {
      console.error(err);
      // Mock data
      setResults([
        { id: 101, job_name: 'TEST_JOB_2026', file_name: 'EXPORT.xlsx', created_at: new Date().toISOString() }
      ]);
    } finally {
      setIsSearching(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="text-xl font-bold text-fuchsia-800 flex items-center gap-2">
            <span className="text-xl">🗄️</span> DB 과거 이력 조회
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
              placeholder="작업명 또는 파일명 검색..."
              className="flex-1 px-4 py-2 border border-slate-300 rounded-lg focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500 outline-none"
              autoFocus
            />
            <button 
              type="submit"
              disabled={isSearching}
              className="flex items-center gap-2 px-6 py-2 bg-fuchsia-600 text-white font-bold rounded-lg hover:bg-fuchsia-700 disabled:bg-fuchsia-400"
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
                  <th className="px-4 py-3 font-bold text-slate-600">작업명</th>
                  <th className="px-4 py-3 font-bold text-slate-600">파일명</th>
                  <th className="px-4 py-3 font-bold text-slate-600">등록일시</th>
                  <th className="px-4 py-3 font-bold text-slate-600 w-24 text-center">불러오기</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {results.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-500">{item.id}</td>
                    <td className="px-4 py-3 font-bold text-slate-700">{item.job_name}</td>
                    <td className="px-4 py-3 text-slate-600">{item.file_name}</td>
                    <td className="px-4 py-3 text-slate-400">{new Date(item.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3 text-center">
                      <button 
                        className="px-3 py-1 text-xs bg-slate-100 text-slate-600 font-bold rounded hover:bg-slate-200"
                        onClick={() => { alert('준비중입니다.'); }}
                      >
                        로드
                      </button>
                    </td>
                  </tr>
                ))}
                {results.length === 0 && !isSearching && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-slate-500">
                      검색 결과가 없습니다.
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
