import { useState, useEffect } from 'react'
import { useAppStore } from './store'
import { FileSpreadsheet, Download, Database, RotateCcw, Box } from 'lucide-react'
import { FileUploader } from './components/FileUploader'
import { ResultsTable } from './components/ResultsTable'
import { ProductMaster } from './components/ProductMaster'

// Modals
import { MappingSettingsModal } from './components/MappingSettingsModal'
import { CarrierMappingModal } from './components/CarrierMappingModal'
import { RuleSettingsModal } from './components/RuleSettingsModal'
import { CautionModelModal } from './components/CautionModelModal'
import { ProductSearchModal } from './components/ProductSearchModal'
import { HStockModal } from './components/HStockModal'
import { PopManagerModal } from './components/PopManagerModal'
import { SettingsModal } from './components/SettingsModal'
import { DBSearchModal } from './components/DBSearchModal'
import { MailSettingsModal } from './components/MailSettingsModal'

function App() {
  const { currentTab, setCurrentTab } = useAppStore();
  
  const [stats, setStats] = useState({ total_carrier: 0, total_rule: 0, total_master: 0 });

  // Modal States
  const [isMappingOpen, setIsMappingOpen] = useState(false);
  const [isCarrierOpen, setIsCarrierOpen] = useState(false);
  const [isRulesOpen, setIsRulesOpen] = useState(false);
  const [isCautionOpen, setIsCautionOpen] = useState(false);
  const [isProductSearchOpen, setIsProductSearchOpen] = useState(false);
  const [isHStockOpen, setIsHStockOpen] = useState(false);
  const [isPopOpen, setIsPopOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDBSearchOpen, setIsDBSearchOpen] = useState(false);
  const [isMailOpen, setIsMailOpen] = useState(false);

  const fetchStats = async () => {
    try {
      const res = await fetch('http://localhost:3000/api/db-stats');
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.stats) {
          setStats({
            total_carrier: parseInt(data.stats.total_carrier) || 0,
            total_rule: parseInt(data.stats.total_rule) || 0,
            total_master: parseInt(data.stats.total_master) || 0,
          });
        }
      }
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-slate-50 text-slate-800">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-2 bg-white border-b shadow-sm shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-slate-800 font-extrabold text-lg bg-slate-900 text-white px-3 py-1.5 rounded-lg">
            <Database className="w-5 h-5 text-blue-400" />
            <span className="text-sm">데이터 선택</span>
          </div>
          
          <nav className="flex items-center gap-1 ml-4 text-sm font-bold text-slate-400">
            <button 
              onClick={() => setCurrentTab('compare')}
              className={`px-3 py-1.5 rounded-md flex items-center gap-1.5 transition-colors ${currentTab === 'compare' ? 'text-indigo-600 bg-indigo-50' : 'hover:bg-slate-100'}`}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
              비교 결과
            </button>
          </nav>
        </div>
        
        {/* Stats */}
        <div className="flex items-center gap-3 bg-green-50 px-3 py-1 rounded-full border border-green-100 text-xs font-bold text-green-700 shadow-sm">
          <span className="flex items-center gap-1"><span className="text-purple-500">🚢 선사:</span> {stats.total_carrier.toLocaleString()}</span>
          <span className="text-green-300">|</span>
          <span className="flex items-center gap-1"><span className="text-emerald-500">📑 규칙:</span> {stats.total_rule.toLocaleString()}</span>
          <span className="text-green-300">|</span>
          <span className="flex items-center gap-1"><span className="text-amber-500">📦 마스터:</span> {stats.total_master.toLocaleString()}</span>
          <button 
            onClick={fetchStats}
            className="text-green-500 hover:text-green-700 ml-1 transition-transform hover:rotate-180"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-1.5 items-center bg-slate-50 px-2 py-1 rounded-xl border shadow-sm">
          <button onClick={() => setIsMappingOpen(true)} className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-yellow-800 bg-yellow-50 border border-yellow-200 rounded hover:bg-yellow-100">
            매핑
          </button>
          <button onClick={() => setIsCarrierOpen(true)} className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50">
            선사
          </button>
          <button onClick={() => setIsRulesOpen(true)} className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-blue-800 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100">
            자동분류
          </button>
          <button onClick={() => setIsCautionOpen(true)} className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-red-700 bg-red-50 border border-red-200 rounded hover:bg-red-100">
            주의모델
          </button>
          <button onClick={() => setIsProductSearchOpen(true)} className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded hover:bg-emerald-100">
            제품검색
          </button>
          <button onClick={() => setIsHStockOpen(true)} className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded hover:bg-rose-100">
            H재고
          </button>
          <button onClick={() => setIsPopOpen(true)} className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-orange-700 bg-orange-50 border border-orange-200 rounded hover:bg-orange-100">
            POP
          </button>
          <button onClick={() => setIsSettingsOpen(true)} className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-sky-800 bg-sky-50 border border-sky-200 rounded hover:bg-sky-100">
            DB설정
          </button>
          <button onClick={() => setIsDBSearchOpen(true)} className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-fuchsia-800 bg-fuchsia-50 border border-fuchsia-200 rounded hover:bg-fuchsia-100">
            DB조회
          </button>
          <button onClick={() => setIsMailOpen(true)} className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-violet-800 bg-violet-50 border border-violet-200 rounded hover:bg-violet-100">
            메일
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 overflow-auto p-6 bg-slate-50/50">
        <div className="max-w-[1600px] mx-auto space-y-6">
          
          {/* File Upload Section */}
          <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left Column */}
            <div className="flex flex-col gap-6">
              <FileUploader 
                title="1. 원본 파일 설정 (직사적/법인/혼적당일)" 
                type="original" 
                icon={FileSpreadsheet} 
                colorClass="indigo" 
              />
              <FileUploader 
                title="1-2. 재작업 파일 (선택 - '재작업당일')" 
                type="rework" 
                icon={RotateCcw} 
                colorClass="pink" 
                required={false}
              />
              <FileUploader 
                title="1-3. 창고재고 (선택 사항)" 
                type="warehouse" 
                icon={Box} 
                colorClass="emerald" 
                required={false}
              />
            </div>
            
            {/* Right Column */}
            <div className="flex flex-col gap-6">
              <FileUploader 
                title="2. 다운로드 파일 (전산 데이터)" 
                type="download" 
                icon={Download} 
                colorClass="sky" 
              />
              <ProductMaster />
            </div>
          </section>

          {/* Action and Results Area */}
          <ResultsTable />

        </div>
      </main>

      {/* Modals */}
      <MappingSettingsModal isOpen={isMappingOpen} onClose={() => setIsMappingOpen(false)} />
      <CarrierMappingModal isOpen={isCarrierOpen} onClose={() => setIsCarrierOpen(false)} />
      <RuleSettingsModal isOpen={isRulesOpen} onClose={() => setIsRulesOpen(false)} />
      <CautionModelModal isOpen={isCautionOpen} onClose={() => setIsCautionOpen(false)} />
      <ProductSearchModal isOpen={isProductSearchOpen} onClose={() => setIsProductSearchOpen(false)} />
      <HStockModal isOpen={isHStockOpen} onClose={() => setIsHStockOpen(false)} />
      <PopManagerModal isOpen={isPopOpen} onClose={() => setIsPopOpen(false)} />
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      <DBSearchModal isOpen={isDBSearchOpen} onClose={() => setIsDBSearchOpen(false)} />
      <MailSettingsModal isOpen={isMailOpen} onClose={() => setIsMailOpen(false)} />
    </div>
  )
}

export default App
