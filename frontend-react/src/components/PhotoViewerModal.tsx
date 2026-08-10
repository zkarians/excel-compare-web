import React, { useEffect, useState } from 'react';
import { X, Image as ImageIcon, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

interface Photo {
  id: number;
  photo_path: string;
  remark?: string;
  uploaded_at: string;
}

interface PhotoViewerModalProps {
  cntrNo: string | null;
  onClose: () => void;
}

export function PhotoViewerModal({ cntrNo, onClose }: PhotoViewerModalProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (!cntrNo) return;
    
    const fetchPhotos = async () => {
      setLoading(true);
      setError(null);
      try {
        // TODO: Update with actual API endpoint when server.js is updated
        // For now, this will fail gracefully or hit a mock if we set one up
        const response = await fetch(`http://localhost:3000/api/photos/${encodeURIComponent(cntrNo)}`);
        if (!response.ok) throw new Error('사진 데이터를 불러오는데 실패했습니다.');
        
        const data = await response.json();
        setPhotos(data.photos || []);
      } catch (err: any) {
        console.error(err);
        // Error is expected until server.js is updated
        setError('서버에 연결할 수 없거나 사진이 없습니다.');
      } finally {
        setLoading(false);
      }
    };

    fetchPhotos();
  }, [cntrNo]);

  if (!cntrNo) return null;

  const nextPhoto = () => {
    setCurrentIndex((prev) => (prev + 1) % photos.length);
  };

  const prevPhoto = () => {
    setCurrentIndex((prev) => (prev - 1 + photos.length) % photos.length);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden animate-in fade-in zoom-in duration-200">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
              <ImageIcon className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">{cntrNo} 장입 사진</h2>
              <p className="text-sm text-slate-500">CTNR 앱에서 업로드된 사진을 조회합니다.</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-[500px] bg-slate-900 relative flex items-center justify-center">
          {loading ? (
            <div className="flex flex-col items-center text-slate-400 gap-3">
              <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
              <p>사진을 불러오는 중...</p>
            </div>
          ) : error || photos.length === 0 ? (
            <div className="flex flex-col items-center text-slate-400 gap-3">
              <ImageIcon className="w-16 h-16 text-slate-600 mb-2" />
              <p className="text-lg font-medium text-slate-300">
                {error || '등록된 장입 사진이 없습니다.'}
              </p>
            </div>
          ) : (
            <>
              {/* Image Display */}
              <div className="relative w-full h-full flex flex-col items-center justify-center p-4">
                {/* 
                  Note: In Electron, to load local files outside the workspace securely,
                  we typically use a custom protocol or API. For now, we assume photo_path is accessible 
                  or served statically by the backend server.
                */}
                <img 
                  src={`http://localhost:3000/api/photo-file?path=${encodeURIComponent(photos[currentIndex].photo_path)}`}
                  alt={`Photo ${currentIndex + 1}`}
                  className="max-h-full max-w-full object-contain rounded shadow-lg"
                  onError={(e) => {
                    // Fallback to local file path if running in Electron environment where it might work (unlikely due to web security)
                    // e.currentTarget.src = `file://${photos[currentIndex].photo_path}`;
                  }}
                />
                
                {photos[currentIndex].remark && (
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 text-white px-4 py-2 rounded-lg backdrop-blur-md">
                    {photos[currentIndex].remark}
                  </div>
                )}
              </div>

              {/* Navigation Arrows */}
              {photos.length > 1 && (
                <>
                  <button 
                    onClick={prevPhoto}
                    className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-black/50 text-white rounded-full hover:bg-indigo-600 transition-colors"
                  >
                    <ChevronLeft className="w-6 h-6" />
                  </button>
                  <button 
                    onClick={nextPhoto}
                    className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-black/50 text-white rounded-full hover:bg-indigo-600 transition-colors"
                  >
                    <ChevronRight className="w-6 h-6" />
                  </button>
                  
                  {/* Dots */}
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2">
                    {photos.map((_, idx) => (
                      <button 
                        key={idx}
                        onClick={() => setCurrentIndex(idx)}
                        className={`w-2.5 h-2.5 rounded-full transition-all ${idx === currentIndex ? 'bg-white scale-125' : 'bg-white/40 hover:bg-white/60'}`}
                      />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
