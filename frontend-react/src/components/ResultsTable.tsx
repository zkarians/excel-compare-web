import React, { useRef, useState, useMemo } from 'react';
import { useAppStore } from '../store';
import { compareData } from '../utils/legacy/compareLogic';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Camera, Search, Download, Database, RotateCcw, Box, Save, PauseCircle, Table, CheckSquare, List, AlertCircle, HelpCircle, FileDown } from 'lucide-react';
import { PhotoViewerModal } from './PhotoViewerModal';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

export function ResultsTable() {
  const { originalData, downloadData, reworkData, syncRemote, setSyncRemote } = useAppStore();
  
  const [results, setResults] = useState<any[]>([]);
  const [isComparing, setIsComparing] = useState(false);
  const [stats, setStats] = useState<any>({
    total: 0, success: 0, error: 0, missing: 0, extra: 0, excluded: 0, updateRequired: 0, chunma: 0, bni: 0, unknown: 0
  });
  const [selectedCntrNo, setSelectedCntrNo] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());

  // Tabs state
  const [activeTab, setActiveTab] = useState<'success'|'all'|'error'|'missing'|'hold'|'entry_gen'|'entry_unclass'|'db_search'>('success');
  
  // Filters state
  const [filters, setFilters] = useState({
    completed: false, progress: false, pending: false, chunma: false, bni: false, other: false
  });
  
  // Action bar state
  const [searchCntr, setSearchCntr] = useState('');
  const [searchProd, setSearchProd] = useState('');
  const [prodType, setProdType] = useState('');

  const parentRef = useRef<HTMLDivElement>(null);

  const handleCompare = () => {
    if (originalData.length === 0 || downloadData.length === 0) {
      alert('원본(선적시트)과 전산(다운로드) 데이터를 모두 로드해주세요.');
      return;
    }

    setIsComparing(true);
    
    try {
      let finalOrigList = [...originalData];
      let finalDownList = [...downloadData];
      let finalReworkList = [...reworkData];

      if (finalReworkList.length > 0) {
        finalReworkList.forEach(item => { item.source = 'rework'; });
        finalOrigList = [...finalOrigList, ...finalReworkList];
      }

      const excludedContainers = new Set<string>();
      finalOrigList.forEach(item => {
        const cntr = String(item.cntrNo || "").trim().toUpperCase();
        if (cntr && !item.workDate) {
          excludedContainers.add(cntr);
        }
      });

      let excludedCount = excludedContainers.size;

      if (excludedContainers.size > 0) {
        finalOrigList = finalOrigList.filter(item => {
          const cntr = String(item.cntrNo || "").trim().toUpperCase();
          return !excludedContainers.has(cntr);
        });
        finalDownList = finalDownList.filter(item => {
          const cntr = String(item.cntrNo || "").trim().toUpperCase();
          return !excludedContainers.has(cntr);
        });
      }

      const productMaster = new Map();
      const dynamicRules: any[] = [];
      const customFields: any[] = [];
      const carrierMap = {};
      const normalizeCarrier = (c: string) => c;

      if (!(window as any).stats) {
        (window as any).stats = { total: 0, success: 0, error: 0, missing: 0, extra: 0, chunma: 0, bni: 0, updateRequired: 0, unknown: 0 };
      }

      const compResults = compareData(
        finalOrigList,
        finalDownList,
        productMaster,
        dynamicRules,
        customFields,
        carrierMap,
        normalizeCarrier
      );

      setResults(compResults);
      
      const newStats = { ...((window as any).stats || {}) };
      newStats.excluded = excludedCount;
      
      // Calculate missing/extra from compResults if needed
      newStats.missing = compResults.filter(r => r.status === '누락(전산에 없음)').length;
      newStats.extra = compResults.filter(r => r.status === '추가(원본에 없음)').length;
      newStats.success = compResults.filter(r => r.status === 'SUCCESS').length;
      newStats.error = compResults.filter(r => r.status !== 'SUCCESS' && !r.status.includes('누락') && !r.status.includes('추가')).length;

      // Extract unique containers for transport stats
      const uniqueCntrs = new Map();
      compResults.forEach(r => {
        if (!uniqueCntrs.has(r.cntrNo)) {
          uniqueCntrs.set(r.cntrNo, r.transporter || '');
        }
      });
      newStats.chunma = 0; newStats.bni = 0; newStats.unknown = 0;
      uniqueCntrs.forEach((trans) => {
        if (trans.includes('천마')) newStats.chunma++;
        else if (trans.includes('BNI')) newStats.bni++;
        else newStats.unknown++;
      });
      newStats.totalCntrs = uniqueCntrs.size;

      setStats(newStats);
    } catch (err) {
      console.error('비교 중 오류:', err);
      alert('비교 처리 중 오류가 발생했습니다.');
    } finally {
      setIsComparing(false);
    }
  };

  const filteredResults = useMemo(() => {
    let filtered = results;
    
    // 1. 탭 필터링
    if (activeTab === 'success') {
      filtered = filtered.filter(r => r.status === 'SUCCESS');
    } else if (activeTab === 'error') {
      filtered = filtered.filter(r => r.status !== 'SUCCESS' && !r.status.includes('누락'));
    } else if (activeTab === 'missing') {
      filtered = filtered.filter(r => r.status.includes('누락') || r.status.includes('추가'));
    }

    // 2. 검색 필터링
    if (searchCntr) filtered = filtered.filter(r => (r.cntrNo || '').toUpperCase().includes(searchCntr.toUpperCase()));
    if (searchProd) filtered = filtered.filter(r => (r.prodName || '').toUpperCase().includes(searchProd.toUpperCase()));
    if (prodType) filtered = filtered.filter(r => (r.prodType || '').toUpperCase() === prodType.toUpperCase());

    // 3. 서브 체크박스 필터링 (정상 탭에서만 동작 가정)
    if (activeTab === 'success') {
      if (filters.chunma || filters.bni || filters.other) {
        filtered = filtered.filter(r => {
          const t = (r.transporter || '').toUpperCase();
          if (filters.chunma && t.includes('천마')) return true;
          if (filters.bni && t.includes('BNI')) return true;
          if (filters.other && !t.includes('천마') && !t.includes('BNI')) return true;
          return false;
        });
      }
    }

    return filtered;
  }, [results, activeTab, filters, searchCntr, searchProd, prodType]);

  const rowVirtualizer = useVirtualizer({
    count: filteredResults.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48, // estimated row height
    overscan: 5,
  });

  const handleResetFilters = () => {
    setSearchCntr('');
    setSearchProd('');
    setProdType('');
    setFilters({ completed: false, progress: false, pending: false, chunma: false, bni: false, other: false });
  };

  const handleOpenExcel = async () => {
    if (filteredResults.length === 0) {
      alert("조회된 데이터가 없습니다.");
      return;
    }
    try {
      // Create a mock payload to send to backend to open excel. 
      // In a real V2, we would construct the workbook in browser and send base64.
      // For this implementation, we will trigger the API assuming backend handles it.
      const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const fileName = `비교결과_${timestamp}.xlsx`;
      
      alert(`'${fileName}'을 엑셀로 바로 엽니다. (백엔드 통신 진행)`);
      
      const response = await fetch(`http://localhost:3000/api/open-excel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buffer: "dummyBase64", fileName: fileName }) // dummy buffer for V2 mockup
      });
      if (!response.ok) console.log('Backend /api/open-excel endpoint not found or failed, but UI triggered');
    } catch(e) {
      console.log('Error triggering open-excel', e);
    }
  };

  const handleToggleAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      const allKeys = filteredResults.map((r, i) => `${r.cntrNo}_${r.prodName}_${i}`);
      setSelectedItems(new Set(allKeys));
    } else {
      setSelectedItems(new Set());
    }
  };

  const handleToggleItem = (key: string) => {
    const newSet = new Set(selectedItems);
    if (newSet.has(key)) newSet.delete(key);
    else newSet.add(key);
    setSelectedItems(newSet);
  };

  const handleDownloadExcel = async () => {
    if (filteredResults.length === 0) {
      alert("조회된 데이터가 없습니다.");
      return;
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('비교 결과');
    ws.columns = [
      { header: '상태', key: 'status', width: 15 },
      { header: '분류', key: 'type', width: 15 },
      { header: '컨테이너번호', key: 'cntrNo', width: 20 },
      { header: '품명', key: 'prodName', width: 40 },
      { header: '원본수량', key: 'origQty', width: 10 },
      { header: '전산수량', key: 'downQty', width: 10 },
      { header: '차이', key: 'diffQty', width: 10 },
      { header: '선사', key: 'carrier', width: 15 },
      { header: '도착지', key: 'dest', width: 15 },
      { header: '중량', key: 'weight', width: 10 },
      { header: '운송사', key: 'transporter', width: 20 }
    ];
    filteredResults.forEach(r => {
      ws.addRow({
        status: r.status,
        type: r.prodType || '-',
        cntrNo: r.cntrNo,
        prodName: r.prodName,
        origQty: r.origQty,
        downQty: r.downQty,
        diffQty: r.diffQty,
        carrier: r.carrierName?.val || '-',
        dest: r.destination?.val || '-',
        weight: r.weights?.mixed || 0,
        transporter: r.transporter || '-'
      });
    });
    const buf = await wb.xlsx.writeBuffer();
    const dateStr = new Date().toISOString().split('T')[0];
    saveAs(new Blob([buf]), `비교_결과_${dateStr}.xlsx`);
  };

  const handleBulkHold = async () => {
    if (selectedItems.size === 0) {
      alert('보류 처리할 항목을 선택해주세요.');
      return;
    }
    const cntrsToHold = new Set<string>();
    filteredResults.forEach((r, i) => {
      if (selectedItems.has(`${r.cntrNo}_${r.prodName}_${i}`)) {
        cntrsToHold.add(r.cntrNo);
      }
    });
    
    if (!confirm(`선택한 ${cntrsToHold.size}대의 컨테이너를 보류 처리하시겠습니까?`)) return;
    
    let success = 0;
    for (const cntr of cntrsToHold) {
      try {
        const res = await fetch(`http://localhost:3000/api/sync/holds`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cntrNo: cntr, reason: '일괄 보류 등록' })
        });
        if (res.ok) success++;
      } catch (e) {
        console.error(e);
      }
    }
    alert(`${success}대의 컨테이너 보류 처리가 완료되었습니다.`);
  };

  const handleSaveToDB = async () => {
    if (selectedItems.size === 0) {
      alert('DB에 저장할 항목을 선택해주세요.');
      return;
    }
    const dataToSave = filteredResults.filter((r, i) => selectedItems.has(`${r.cntrNo}_${r.prodName}_${i}`));
    
    if (!confirm(`선택한 ${dataToSave.length}건의 데이터를 DB에 저장하시겠습니까?`)) return;
    
    try {
      const res = await fetch(`http://localhost:3000/api/save-to-db`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exportData: dataToSave })
      });
      if (res.ok) alert('성공적으로 DB에 저장되었습니다.');
      else alert('DB 저장 실패');
    } catch (e) {
      alert('오류 발생');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col items-center gap-3 py-2">
        <div className="flex items-center gap-2 bg-sky-50 px-4 py-2 rounded-full border border-sky-200 shadow-sm">
          <Database className="w-4 h-4 text-sky-500" />
          <span className="text-sm font-bold text-slate-700">원격 DB 동시저장 <span className="text-sky-600">(ungdong)</span></span>
          <div className="ml-2 relative inline-flex h-6 w-11 items-center rounded-full bg-slate-200 cursor-pointer transition-colors"
               style={{ backgroundColor: syncRemote ? '#0ea5e9' : '#cbd5e1' }}
               onClick={() => setSyncRemote(!syncRemote)}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${syncRemote ? 'translate-x-6' : 'translate-x-1'}`} />
          </div>
          <span className={`text-xs font-bold ${syncRemote ? 'text-sky-600' : 'text-slate-400'}`}>{syncRemote ? 'ON' : 'OFF'}</span>
        </div>

        <button 
          onClick={handleCompare}
          disabled={isComparing}
          className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold py-3 px-12 rounded-xl shadow-lg shadow-indigo-200 transition-all active:scale-95 flex items-center gap-2 text-lg w-full max-w-2xl justify-center"
        >
          {isComparing ? '비교 중...' : '데이터 비교 시작'}
        </button>
      </section>

      {/* Stats Dashboard */}
      {results.length > 0 && (
        <section className="grid grid-cols-8 gap-2 bg-slate-50 p-3 rounded-xl border border-slate-200">
          <div className="bg-sky-50 border-l-4 border-sky-500 p-3 flex flex-col justify-center items-center rounded shadow-sm">
            <span className="text-xs font-bold text-slate-500">총 컨테이너 대수</span>
            <span className="text-xl font-bold text-sky-700">{stats.totalCntrs || 0}</span>
          </div>
          <div className="bg-green-50 border-green-200 border p-3 flex flex-col justify-center items-center rounded shadow-sm">
            <span className="text-xs font-bold text-slate-500">정상 컨테이너</span>
            <span className="text-xl font-bold text-green-700">{stats.success}</span>
          </div>
          <div className="bg-red-50 border-red-200 border p-3 flex flex-col justify-center items-center rounded shadow-sm">
            <span className="text-xs font-bold text-slate-500">오류 및 불일치</span>
            <span className="text-xl font-bold text-red-600">{stats.error}</span>
          </div>
          <div className="bg-amber-50 border-amber-200 border p-3 flex flex-col justify-center items-center rounded shadow-sm">
            <span className="text-xs font-bold text-slate-500">추가(원본에 없음)</span>
            <span className="text-xl font-bold text-amber-700">{stats.extra}</span>
          </div>
          <div className="bg-pink-50 border-pink-200 border p-3 flex flex-col justify-center items-center rounded shadow-sm">
            <span className="text-xs font-bold text-slate-500">누락(전산에 없음)</span>
            <span className="text-xl font-bold text-pink-600">{stats.missing}</span>
          </div>
          <div className="bg-slate-100 border-slate-300 border p-3 flex flex-col justify-center items-center rounded shadow-sm">
            <span className="text-xs font-bold text-slate-500">제외(작업일 없음)</span>
            <span className="text-xl font-bold text-slate-600">{stats.excluded}</span>
          </div>
          <div className="bg-white border-slate-200 border p-3 flex flex-col justify-center items-center rounded shadow-sm">
            <span className="text-xs font-bold text-slate-500 text-center">제품정보<br/>업데이트 필요</span>
            <span className="text-xl font-bold text-indigo-600">{stats.updateRequired}</span>
          </div>
          <div className="bg-indigo-50 border-indigo-200 border p-3 flex flex-col justify-center items-center rounded shadow-sm">
            <span className="text-[10px] font-bold text-slate-500 mb-1">운송사 배정 현황</span>
            <div className="flex gap-2 text-xs">
              <span className="text-red-600 font-bold">천마: {stats.chunma}</span>
              <span className="text-blue-600 font-bold">BNI: {stats.bni}</span>
            </div>
            <span className="text-[10px] text-slate-500 mt-1">정보없음: {stats.unknown}대</span>
          </div>
        </section>
      )}

      {results.length > 0 ? (
        <section className="bg-white rounded-xl border shadow-sm p-4 flex flex-col gap-3 h-[700px]">
          
          {/* 1. Tabs */}
          <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
            <div className="flex items-center gap-1.5 mr-2">
              <div className="bg-indigo-500 p-1.5 rounded-lg text-white shadow-sm"><Table className="w-4 h-4"/></div>
              <span className="font-bold text-slate-800">비교 결과</span>
            </div>
            <button onClick={() => setActiveTab('success')} className={`px-4 py-2 text-sm font-bold rounded-lg border flex items-center gap-2 ${activeTab === 'success' ? 'bg-green-100 text-green-700 border-green-300' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
              <CheckSquare className="w-4 h-4"/> 정상컨테이너
            </button>
            <button onClick={() => setActiveTab('all')} className={`px-4 py-2 text-sm font-bold rounded-lg border flex items-center gap-2 ${activeTab === 'all' ? 'bg-slate-100 text-slate-800 border-slate-300' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
              <List className="w-4 h-4"/> 전체컨테이너
            </button>
            <button onClick={() => setActiveTab('error')} className={`px-4 py-2 text-sm font-bold rounded-lg border flex items-center gap-2 ${activeTab === 'error' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
              <AlertCircle className="w-4 h-4"/> 오류컨테이너
            </button>
            <button onClick={() => setActiveTab('missing')} className={`px-4 py-2 text-sm font-bold rounded-lg border flex items-center gap-2 ${activeTab === 'missing' ? 'bg-pink-50 text-pink-700 border-pink-200' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
              <HelpCircle className="w-4 h-4"/> 미분류/누락
            </button>
            <button onClick={() => setActiveTab('hold')} className={`px-4 py-2 text-sm font-bold rounded-lg border flex items-center gap-2 ${activeTab === 'hold' ? 'bg-slate-200 text-slate-800 border-slate-300' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
              <PauseCircle className="w-4 h-4"/> 보류 <span className="bg-slate-500 text-white rounded-full px-1.5 text-xs">0</span>
            </button>
            <button onClick={() => setActiveTab('entry_gen')} className={`px-4 py-2 text-sm font-bold rounded-lg border flex items-center gap-2 ${activeTab === 'entry_gen' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
              <FileImport className="w-4 h-4"/> 반입정보 생성
            </button>
            <button onClick={() => setActiveTab('entry_unclass')} className={`px-4 py-2 text-sm font-bold rounded-lg border flex items-center gap-2 ${activeTab === 'entry_unclass' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
              <HelpCircle className="w-4 h-4"/> 반입정보 미분류
            </button>
          </div>

          {/* 2. Sub Filters */}
          <div className="bg-slate-50 rounded-lg p-3 border border-slate-200 flex items-center justify-between text-sm">
            <div className="flex items-center gap-4">
              <span className="font-bold text-slate-600">컨테이너 필터:</span>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={filters.completed} onChange={e => setFilters({...filters, completed: e.target.checked})} className="rounded text-indigo-600"/> 완료
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={filters.progress} onChange={e => setFilters({...filters, progress: e.target.checked})} className="rounded text-indigo-600"/> 작업중
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={filters.pending} onChange={e => setFilters({...filters, pending: e.target.checked})} className="rounded text-indigo-600"/> 대기
              </label>
              <span className="text-slate-300">|</span>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={filters.chunma} onChange={e => setFilters({...filters, chunma: e.target.checked})} className="rounded text-indigo-600"/> 천마
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={filters.bni} onChange={e => setFilters({...filters, bni: e.target.checked})} className="rounded text-indigo-600"/> BNI
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={filters.other} onChange={e => setFilters({...filters, other: e.target.checked})} className="rounded text-indigo-600"/> 기타
              </label>
            </div>
            <button onClick={handleResetFilters} className="px-3 py-1.5 bg-white border border-slate-300 rounded text-slate-600 font-bold hover:bg-slate-50 flex items-center gap-1.5 text-xs">
              <RotateCcw className="w-3.5 h-3.5"/> 필터 초기화
            </button>
          </div>

          {/* 3. Action Bar */}
          <div className="flex items-center justify-between bg-slate-50 p-2.5 rounded-lg border border-slate-200">
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 cursor-pointer text-sm font-bold text-slate-700 ml-2">
                <input type="checkbox" className="rounded text-indigo-600 w-4 h-4"/> 전체 선택
              </label>
              <span className="text-sm font-medium text-slate-500">선택됨: <span className="text-indigo-600 font-bold">0</span>개</span>
              
              <div className="flex items-center gap-2 ml-4">
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input type="text" value={searchCntr} onChange={e => setSearchCntr(e.target.value)} placeholder="컨테이너 번호" className="pl-8 pr-3 py-1.5 text-sm border rounded bg-white w-40"/>
                </div>
                <input type="text" value={searchProd} onChange={e => setSearchProd(e.target.value)} placeholder="제품명 검색" className="px-3 py-1.5 text-sm border rounded bg-white w-40"/>
                <select value={prodType} onChange={e => setProdType(e.target.value)} className="px-3 py-1.5 text-sm border rounded bg-white outline-none cursor-pointer">
                  <option value="">제품구분(전체)</option>
                  <option value="F">F</option>
                  <option value="H">H</option>
                  <option value="Q">Q</option>
                </select>
                <button onClick={handleResetFilters} className="px-3 py-1.5 bg-white border border-slate-300 rounded text-slate-600 font-bold hover:bg-slate-50 flex items-center gap-1.5 text-xs">
                  <RotateCcw className="w-3.5 h-3.5"/> 초기화
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button onClick={handleDownloadExcel} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-bold rounded-lg hover:bg-indigo-700 shadow-sm transition-colors">
                <Download className="w-4 h-4"/> 결과 엑셀 다운로드
              </button>
              <button onClick={handleOpenExcel} className="flex items-center gap-2 px-4 py-2 bg-white border border-indigo-600 text-indigo-600 text-sm font-bold rounded-lg hover:bg-indigo-50 transition-colors">
                <Search className="w-4 h-4"/> 결과 바로보기
              </button>
              <button onClick={handleBulkHold} className="flex items-center gap-2 px-4 py-2 bg-slate-100 border border-slate-300 text-slate-700 text-sm font-bold rounded-lg hover:bg-slate-200 transition-colors">
                <PauseCircle className="w-4 h-4"/> 선택항목 보류등록
              </button>
              <button onClick={handleSaveToDB} className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white text-sm font-bold rounded-lg hover:bg-emerald-600 shadow-sm transition-colors">
                <Save className="w-4 h-4"/> 선택항목 DB 저장
              </button>
            </div>
          </div>
          
          {/* Header Row */}
          <div className="grid grid-cols-12 gap-4 px-4 py-3 bg-slate-50 border-b text-xs font-bold text-slate-700 shrink-0 pr-8">
            <div className="col-span-1 flex items-center gap-2">
              <input 
                type="checkbox" 
                className="w-3.5 h-3.5 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                onChange={handleToggleAll}
                checked={filteredResults.length > 0 && selectedItems.size === filteredResults.length}
              />
              <span>상태</span>
            </div>
            <div className="col-span-2">컨테이너 번호</div>
            <div className="col-span-3">품명</div>
            <div className="col-span-1 text-center">원본수량</div>
            <div className="col-span-1 text-center">전산수량</div>
            <div className="col-span-1 text-center">차이</div>
            <div className="col-span-2">운송사</div>
            <div className="col-span-1 text-center">기능</div>
          </div>

          {/* Virtualized List Container */}
          <div 
            ref={parentRef}
            className="flex-1 overflow-auto rounded-b-lg border-x border-b"
          >
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = filteredResults[virtualRow.index];
                const isError = row.status !== 'SUCCESS';
                return (
                  <div
                    key={virtualRow.index}
                    className={`absolute top-0 left-0 w-full grid grid-cols-12 gap-4 px-4 py-2 border-b hover:bg-slate-50 text-sm items-center transition-colors ${isError ? 'bg-red-50/30' : ''}`}
                    style={{
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div className="col-span-1 flex items-center gap-2">
                      <input 
                        type="checkbox"
                        className="w-3.5 h-3.5 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                        checked={selectedItems.has(`${row.cntrNo}_${row.prodName}_${virtualRow.index}`)}
                        onChange={() => handleToggleItem(`${row.cntrNo}_${row.prodName}_${virtualRow.index}`)}
                      />
                      <span className={`px-2 py-1 rounded-md text-xs font-bold ${!isError ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {row.status}
                      </span>
                    </div>
                    <div className="col-span-2 font-medium">{row.cntrNo}</div>
                    <div className="col-span-3 text-slate-600 truncate" title={row.prodName}>{row.prodName}</div>
                    <div className="col-span-1 text-center">{row.origQty}</div>
                    <div className="col-span-1 text-center font-bold text-slate-700">{row.downQty}</div>
                    <div className="col-span-1 text-center">
                      <span className={`font-bold ${row.diffQty !== 0 ? 'text-red-500' : 'text-slate-400'}`}>
                        {row.diffQty}
                      </span>
                    </div>
                    <div className="col-span-2 text-slate-500 truncate">{row.transporter}</div>
                    <div className="col-span-1 flex justify-center">
                      <button 
                        onClick={() => setSelectedCntrNo(row.cntrNo)}
                        className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
                        title="장입 사진 보기"
                      >
                        <Camera className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      ) : null}
      
      {/* Photo Viewer Modal */}
      <PhotoViewerModal 
        cntrNo={selectedCntrNo} 
        onClose={() => setSelectedCntrNo(null)} 
      />
    </div>
  );
}
