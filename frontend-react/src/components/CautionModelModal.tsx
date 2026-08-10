import { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';

interface CautionModelModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CautionModelModal({ isOpen, onClose }: CautionModelModalProps) {
  const [cautionModels, setCautionModels] = useState('');

  useEffect(() => {
    if (isOpen) {
      const stored = localStorage.getItem('cautionModels');
      if (stored) {
        setCautionModels(stored);
      } else {
        // 기본값 설정 (V1 기준)
        setCautionModels('LT1000P.AETC1, LT1000P, MDJ64844601');
      }
    }
  }, [isOpen]);

  const handleSave = () => {
    localStorage.setItem('cautionModels', cautionModels);
    alert('주의모델이 저장되었습니다. 비교 시 해당 키워드가 포함된 품목은 강조 표시됩니다.');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-xl font-bold text-red-600 flex items-center gap-2">
            <span className="text-xl">⚠️</span> 주의 모델 설정
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 bg-slate-50">
          <p className="text-sm text-slate-600 mb-4 bg-white p-3 rounded border shadow-sm">
            아래에 쉼표(,)로 구분하여 주의가 필요한 모델명이나 키워드를 입력하세요.<br/>
            비교 결과에서 해당 키워드가 포함된 품목은 <span className="text-red-500 font-bold">빨간색 경고 아이콘</span>과 함께 굵게 표시됩니다.
          </p>

          <textarea
            value={cautionModels}
            onChange={(e) => setCautionModels(e.target.value)}
            className="w-full h-32 p-3 border border-slate-300 rounded focus:border-red-500 focus:ring-1 focus:ring-red-500 outline-none text-sm"
            placeholder="LT1000P, 모델명, 키워드..."
          />
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
            className="flex items-center gap-2 px-6 py-2 text-sm font-bold text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
          >
            <Save className="w-4 h-4" />
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
