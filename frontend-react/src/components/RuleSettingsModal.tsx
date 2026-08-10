import { useState, useEffect } from 'react';
import { X, Save, Plus, Edit2, Trash2, Power } from 'lucide-react';

interface RuleSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Condition {
  field: string;
  operator: string;
  value: string;
}

interface Rule {
  id: string;
  isActive: boolean;
  conditionOperator: 'AND' | 'OR';
  conditions: Condition[];
  targetField: string;
  targetValue: string;
  description: string;
  priority: number;
}

export function RuleSettingsModal({ isOpen, onClose }: RuleSettingsModalProps) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadRules();
    }
  }, [isOpen]);

  const loadRules = async () => {
    try {
      const response = await fetch('http://localhost:3000/api/sync/rules');
      if (response.ok) {
        const data = await response.json();
        if (data.success && Array.isArray(data.rules) && data.rules.length > 0) {
          setRules(data.rules);
          return;
        }
      }
      
      const localResp = await fetch('http://localhost:3000/api/rules');
      if (localResp.ok) {
        const localData = await localResp.json();
        if (localData.success && Array.isArray(localData.rules)) {
          setRules(localData.rules);
        }
      }
    } catch (err) {
      console.error('Failed to load rules', err);
    }
  };

  const saveRules = async (newRules: Rule[]) => {
    setRules(newRules);
    try {
      await fetch('http://localhost:3000/api/sync/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: newRules })
      });
      // Also save to local file via old API just in case
      await fetch('http://localhost:3000/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: newRules })
      });
    } catch (err) {
      console.error('Failed to save rules', err);
    }
  };

  const handleDelete = (id: string) => {
    if (confirm('이 규칙을 삭제하시겠습니까?')) {
      saveRules(rules.filter(r => r.id !== id));
    }
  };

  const toggleActive = (id: string) => {
    saveRules(rules.map(r => r.id === id ? { ...r, isActive: !r.isActive } : r));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <span className="text-xl">📋</span> 자동분류 & 데이터 교정 규칙
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 bg-slate-50">
          <div className="flex justify-between items-center mb-4">
            <p className="text-sm text-slate-500">
              조건에 맞는 데이터를 자동으로 분류하거나 오류 메시지를 삽입할 수 있습니다.
            </p>
            <button className="flex items-center gap-1 px-4 py-2 text-sm font-bold text-white bg-indigo-600 rounded hover:bg-indigo-700 shadow-sm">
              <Plus className="w-4 h-4" />
              새 규칙 추가
            </button>
          </div>

          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 border-b">
                <tr>
                  <th className="px-4 py-3 font-bold text-slate-600 w-12 text-center">상태</th>
                  <th className="px-4 py-3 font-bold text-slate-600 w-1/4">설명 (우선순위)</th>
                  <th className="px-4 py-3 font-bold text-slate-600">조건 및 변경내역 요약</th>
                  <th className="px-4 py-3 font-bold text-slate-600 w-24 text-center">관리</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rules.map((rule) => (
                  <tr key={rule.id} className={`hover:bg-slate-50 ${!rule.isActive ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-3 text-center">
                      <button 
                        onClick={() => toggleActive(rule.id)}
                        className={`p-1.5 rounded-full ${rule.isActive ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-200 text-slate-500'}`}
                        title={rule.isActive ? '사용 중' : '사용 안함'}
                      >
                        <Power className="w-4 h-4" />
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-bold text-slate-700">{rule.description || '이름 없는 규칙'}</div>
                      <div className="text-xs text-slate-500 mt-1">우선순위: {rule.priority}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-slate-600 space-y-1">
                        <div className="flex gap-1 flex-wrap">
                          <span className="font-semibold text-indigo-600">IF:</span>
                          {rule.conditions.map((c, i) => (
                            <span key={i} className="bg-indigo-50 px-1.5 py-0.5 rounded text-indigo-700">
                              {c.field} {c.operator} {c.value} {i < rule.conditions.length - 1 ? <span className="text-slate-400 mx-1">{rule.conditionOperator}</span> : ''}
                            </span>
                          ))}
                        </div>
                        <div className="flex gap-1 mt-1">
                          <span className="font-semibold text-rose-600">THEN:</span>
                          <span className="bg-rose-50 px-1.5 py-0.5 rounded text-rose-700">
                            {rule.targetField} = {rule.targetValue.replace(/<[^>]*>?/gm, '').substring(0, 50)}...
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center flex justify-center gap-2 mt-2">
                      <button 
                        onClick={() => setEditingRule(rule)}
                        className="p-1 text-blue-600 hover:bg-blue-50 rounded"
                        title="수정 (준비중)"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => handleDelete(rule.id)}
                        className="p-1 text-red-600 hover:bg-red-50 rounded"
                        title="삭제"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {rules.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                      등록된 자동분류 규칙이 없습니다.
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
