// --------------------------------------------------
// compareLogic.js - 원본/전산 데이터 비교 핵심 알고리즘
// --------------------------------------------------

/**
 * 0 중량/치수 제품 및 지정 모델을 NONASSET.ITEM으로 취급할지 확인
 */
function checkIsNonAsset(prodName, productMap) {
    const cleanName = (prodName || "").trim().toUpperCase();
    if (cleanName.includes("NONASSET")) return true;

    // 제품 마스터에서 무게/크기가 모두 0이면 부품(NONASSET) 취급
    if (productMap && productMap.has(cleanName)) {
        const prod = productMap.get(cleanName);
        const w = parseFloat(prod.weight) || 0;
        const width = parseFloat(prod.width) || 0;
        const height = parseFloat(prod.height) || 0;
        const depth = parseFloat(prod.depth) || 0;
        if (w === 0 && width === 0 && height === 0 && depth === 0) return true;
    }
    return false;
}

/**
 * 수식 문자열(+10, -5, *2, /2, =100) 평가
 */
function evaluateMathString(currentVal, expr) {
    if (!expr) return currentVal;
    let str = expr.trim();
    if (str.startsWith('+')) return currentVal + parseFloat(str.substring(1));
    if (str.startsWith('-')) return currentVal - parseFloat(str.substring(1));
    if (str.startsWith('*')) return currentVal * parseFloat(str.substring(1));
    if (str.startsWith('/')) return currentVal / parseFloat(str.substring(1));
    if (str.startsWith('=')) return parseFloat(str.substring(1));
    let num = parseFloat(str);
    if (!isNaN(num)) return num;
    return currentVal;
}

/**
 * 데이터 비교 핵심 함수
 */
function compareData(origList, downList, productMaster, dynamicRules, customFields, carrierMap, normalizeCarrier) {
    const results = [];
    // stats는 호출부(app_main.js)의 글로벌 변수를 사용하거나 반환 객체에 담아 전달
    const stats = { total: 0, success: 0, error: 0, missing: 0, extra: 0, chunma: 0, bni: 0, updateRequired: 0 };

    if (typeof missingProductsSet !== 'undefined') missingProductsSet.clear();
    if (typeof weightMismatchSet !== 'undefined') weightMismatchSet.clear();

    const productMap = new Map();
    if (Array.isArray(productMaster)) {
        productMaster.forEach(p => {
            if (p.name) productMap.set(String(p.name).trim().toUpperCase(), p);
        });
    }

    const origGrouped = {};
    const NON_ASSET_ID = "NONASSET.ITEM";

    origList.forEach(orig => {
        let cleanCntr = (orig.cntrNo || "").trim().toUpperCase();
        let effectiveProdName = (orig.prodName || "").trim().toUpperCase();
        const isNumeric = /^\d+$/.test(effectiveProdName);
        const hasNoDot = !effectiveProdName.includes('.');
        if (isNumeric || (effectiveProdName && hasNoDot)) {
            effectiveProdName = NON_ASSET_ID;
        }

        const key = cleanCntr + "|" + effectiveProdName;
        if (!origGrouped[key]) {
            origGrouped[key] = { ...orig, prodName: effectiveProdName, qtySum: 0, source: orig.source || "original", tags: [...(orig.tags || [])] };
        } else {
            if (orig.tags) {
                orig.tags.forEach(t => {
                    if (!origGrouped[key].tags.some(existing => existing.text === t.text)) {
                        origGrouped[key].tags.push(t);
                    }
                });
            }
            if (!origGrouped[key].dest && orig.dest) {
                origGrouped[key].dest = orig.dest;
            }
        }
        origGrouped[key].qtySum += (Number(orig.qty) || 0);
    });

    const downGrouped = {};
    downList.forEach(down => {
        let cleanCntr = (down.cntrNo || "").trim().toUpperCase();
        let cleanProdName = (down.prodName || "").trim().toUpperCase();
        const key = cleanCntr + "|" + cleanProdName;
        if (!downGrouped[key]) {
            downGrouped[key] = {
                ...down,
                loadQtySum: 0,
                planQtySum: 0,
                pendingQtySum: 0,
                packingQtySum: 0,
                remainQtySum: 0,
                volumeSum: 0,
                weightSum: 0,
                loadPlanNo: down.loadPlanNo || "",
                loadType: down.loadType || "",
                sealNo: down.sealNo || "",
                port: down.port || "",
                forwarder: down.forwarder || "",
                carrier: down.carrier || "",
                remark: down.remark || "",
                oqc: down.oqc || "",
                division: down.division || ""
            };
        } else {
            if (!downGrouped[key].division && down.division) {
                downGrouped[key].division = down.division;
            }
            if (!downGrouped[key].prodType && down.prodType) {
                downGrouped[key].prodType = down.prodType;
            }
        }
        downGrouped[key].loadQtySum += (Number(down.loadQty) || 0);
        downGrouped[key].planQtySum += (Number(down.planQty) || 0);
        downGrouped[key].pendingQtySum += (Number(down.pendingQty) || 0);
        downGrouped[key].packingQtySum += (Number(down.packingQty) || 0);
        downGrouped[key].remainQtySum = (downGrouped[key].remainQtySum || 0) + (Number(down.remainQty) || 0);
        downGrouped[key].volumeSum += (Number(down.volume) || 0);
        downGrouped[key].weightSum += (Number(down.grossWeight) || 0);
    });

    const origCntrMap = new Map();
    origList.forEach(o => {
        let cleanCntr = (o.cntrNo || "").trim().toUpperCase();
        if (!origCntrMap.has(cleanCntr)) {
            origCntrMap.set(cleanCntr, { ...o, combinedRemark: (o.remark || "") + " " + (o.adj1 || "") + " " + (o.adj2 || "") });
        } else {
            const entry = origCntrMap.get(cleanCntr);
            const rowRemark = (o.remark || "") + " " + (o.adj1 || "") + " " + (o.adj2 || "");
            if (rowRemark && !entry.combinedRemark.includes(rowRemark)) {
                entry.combinedRemark += " " + rowRemark;
            }
        }
    });

    const today = new Date();
    const workDateStr = `${today.getMonth() + 1}월 ${today.getDate()}일`;

    const downKeys = Object.keys(downGrouped);
    downKeys.forEach(key => {
        const down = downGrouped[key];
        const matchedOrig = origGrouped[key];

        let isError = false;
        let errorDetails = [];
        let rowType = '정상 진행';
        let rowClass = '';
        let rowBadge = 'success';
        let transporter = "미분류";
        let cleanCntr = (down.cntrNo || "").trim().toUpperCase();
        let contMatchOrig = origCntrMap.get(cleanCntr);
        if (contMatchOrig) transporter = contMatchOrig.transporter;

        let evalDest = matchedOrig ? (matchedOrig.dest || down.dest || "") : (down.dest || "");
        let evalProdName = down.prodName || "";
        const cntrInfo = origCntrMap.get(cleanCntr);
        let evalRemark = cntrInfo ? (cntrInfo.combinedRemark || "") : "";

        let downPort = down.port || "";
        let downForwarder = down.forwarder || "";
        let downCarrier = down.carrier || "";
        let downRemark = down.remark || "";
        let origRemark = matchedOrig ? (matchedOrig.remark || "") : "";
        let downLoadType = down.loadType || "";
        let downPlanQty = String(down.planQtySum || 0);
        let downPackingQty = String(down.packingQtySum || 0);
        let downSealNo = down.sealNo || "";

        if (dynamicRules) {
            dynamicRules.forEach(rule => {
                if (!rule.isActive || !rule.conditions || rule.conditions.length === 0) return;
                const conditionMethod = rule.conditionOperator === 'OR' ? 'some' : 'every';
                const allMatched = rule.conditions[conditionMethod](cond => {
                    let targetText = "";
                    if (cond.field && cond.field.startsWith('f_')) {
                        const cf = (customFields || []).find(f => f.id === cond.field);
                        if (cf) {
                            const targetIdx = cf.colIdx + 1;
                            if (cf.source === 'down') {
                                targetText = (down.rawRow && down.rawRow[targetIdx] ? String(down.rawRow[targetIdx]) : "").toUpperCase();
                            } else {
                                targetText = (matchedOrig && matchedOrig.rawRow && matchedOrig.rawRow[targetIdx] ? String(matchedOrig.rawRow[targetIdx]) : "").toUpperCase();
                            }
                        }
                    }
                    else if (cond.field === 'remark') targetText = (evalRemark + " " + downRemark).toUpperCase();
                    else if (cond.field === 'prodName') targetText = evalProdName.toUpperCase().trim();
                    else if (cond.field === 'dest') targetText = evalDest.toUpperCase().trim();
                    else if (cond.field === 'downPort') targetText = downPort.toUpperCase().trim();
                    else if (cond.field === 'downForwarder') targetText = downForwarder.toUpperCase().trim();
                    else if (cond.field === 'downCarrier') targetText = downCarrier.toUpperCase().trim();
                    else if (cond.field === 'downRemark') targetText = downRemark.toUpperCase().trim();
                    else if (cond.field === 'origRemark') targetText = origRemark.toUpperCase().trim();
                    else if (cond.field === 'downLoadType') targetText = downLoadType.toUpperCase().trim();
                    else if (cond.field === 'downPlanQty') targetText = downPlanQty.toUpperCase().trim();
                    else if (cond.field === 'downPackingQty') targetText = downPackingQty.toUpperCase().trim();
                    else if (cond.field === 'downPendingQty') targetText = String(down.pendingQtySum || 0).toUpperCase().trim();
                    else if (cond.field === 'downSealNo') targetText = downSealNo.toUpperCase().trim();
                    else if (cond.field === 'prodType') {
                        targetText = matchedOrig ? (matchedOrig.prodType || down.prodType || "").toUpperCase().trim() : (down.prodType || "").toUpperCase().trim();
                    }
                    const keyword = (cond.value || "").toUpperCase();
                    const rawValue = cond.value || "";

                    if (cond.operator === 'ratioMismatch') {
                        const parts = cond.value.split(':');
                        if (parts.length === 2) {
                            const otherField = parts[0];
                            const ratio = parseFloat(parts[1]);
                            let otherValue = 0;
                            if (otherField === 'downPlanQty') otherValue = parseFloat(downPlanQty) || 0;
                            else if (otherField === 'downPackingQty') otherValue = parseFloat(downPackingQty) || 0;
                            else if (otherField === 'downLoadQty') otherValue = parseFloat(downLoadType) || 0;

                            const currentVal = parseFloat(targetText) || 0;
                            const expectedVal = otherValue * ratio;
                            return Math.abs(currentVal - expectedVal) > 0.001;
                        }
                        return false;
                    }
                    if (cond.operator === 'exact') return targetText === keyword;
                    if (cond.operator === 'notIncludes') return !targetText.includes(keyword);
                    if (cond.operator === 'startsWith') return targetText.startsWith(keyword);
                    if (cond.operator === 'includes') return targetText.includes(keyword);
                    if (cond.operator === 'regexMatch') {
                        try {
                            const re = new RegExp(rawValue, 'i');
                            return re.test(targetText);
                        } catch (e) { return false; }
                    }
                    if (cond.operator === 'regexNotMatch') {
                        try {
                            const re = new RegExp(rawValue, 'i');
                            return !re.test(targetText);
                        } catch (e) { return false; }
                    }

                    // 수치 비교 연산자 처리
                    const targetNum = parseFloat(targetText);
                    const keywordNum = parseFloat(keyword);
                    if (isNaN(targetNum) || isNaN(keywordNum)) return false;

                    if (cond.operator === 'gte') return targetNum >= keywordNum;
                    if (cond.operator === 'gt') return targetNum > keywordNum;
                    if (cond.operator === 'lte') return targetNum <= keywordNum;
                    if (cond.operator === 'lt') return targetNum < keywordNum;
                    if (cond.operator === 'numEq') return Math.abs(targetNum - keywordNum) < 0.001;

                    return targetText.includes(keyword); // Fallback
                });

                if (allMatched) {
                    let finalTargetValue = rule.targetValue || "";
                    if (typeof finalTargetValue === 'string') {
                        const placeholders = {
                            downPlanQty: downPlanQty,
                            downPackingQty: downPackingQty,
                            prodName: evalProdName,
                            prodType: matchedOrig ? (matchedOrig.prodType || down.prodType || "") : (down.prodType || "")
                        };
                        Object.keys(placeholders).forEach(key => {
                            finalTargetValue = finalTargetValue.replace(new RegExp(`{{${key}}}`, 'g'), placeholders[key]);
                        });
                    }

                    if (rule.targetField === 'tags') {
                        if (matchedOrig) {
                            matchedOrig.tags = matchedOrig.tags || [];
                            if (!matchedOrig.tags.some(t => t.text === finalTargetValue)) {
                                matchedOrig.tags.push({ text: finalTargetValue, type: rule.tagColor || "info" });
                            }
                            // [추가] 빨간색(danger) 태그인 경우 오류로 취급
                            if (rule.tagColor === 'danger') {
                                isError = true;
                                if (!errorDetails.includes(finalTargetValue)) {
                                    errorDetails.push(finalTargetValue);
                                }
                            }
                        }
                    } else if (rule.targetField === 'carrier') {
                        if (matchedOrig) matchedOrig.carrier = finalTargetValue;
                    } else if (rule.targetField === 'dest') {
                        if (matchedOrig) matchedOrig.dest = finalTargetValue;
                        down.dest = finalTargetValue;
                    } else if (rule.targetField === 'errorDetail') {
                        errorDetails.push(finalTargetValue);
                        isError = true;
                    } else if (rule.targetField === 'planQty') {
                        down.planQtySum = evaluateMathString(down.planQtySum, finalTargetValue);
                    } else if (rule.targetField === 'loadQty') {
                        down.loadQtySum = evaluateMathString(down.loadQtySum, finalTargetValue);
                    } else if (rule.targetField === 'packingQty') {
                        down.packingQtySum = evaluateMathString(down.packingQtySum, finalTargetValue);
                    } else if (rule.targetField === 'transporter') {
                        transporter = rule.targetValue;
                    }
                }
            });
        }

        let origDest = "";
        let downDest = (down.dest || "").toUpperCase();
        let carrierMatched = true;
        let sizeMatched = true;

        if (!matchedOrig) {
            const isNonAsset = checkIsNonAsset(down.prodName, productMap);
            if (isNonAsset) {
                rowType = '원본모델누락';
                rowBadge = 'extra';
                errorDetails.push(`원본 파일에 해당 모델[${down.prodName}] 정보 없음 (비자산 항목)`);
            } else {
                stats.extra++;
                isError = true;
                rowClass = 'row-new';
                rowBadge = 'extra';
                rowType = '원본모델누락';
                errorDetails.push(contMatchOrig ? `원본 작업내역에 해당 모델[${down.prodName}] 없음` : `원본 파일에 컨테이너 정보 없음`);
            }
        } else {
            if (matchedOrig.qtySum !== down.loadQtySum && matchedOrig.qtySum !== down.planQtySum) {
                errorDetails.push(`수량 불일치(원본:${matchedOrig.qtySum} ↔ 적재:${down.loadQtySum}, 계획:${down.planQtySum})`);
                isError = true;
            }
            if (down.oqc !== 'Y') {
                let oqcRequired = (matchedOrig.remark + (matchedOrig.adj1 || "") + (matchedOrig.adj2 || "")).includes("반품물");
                if (oqcRequired) {
                    errorDetails.push(`반품 제품 포함 (OQC: ${down.oqc})`);
                    isError = true;
                }
            }
            origDest = (matchedOrig.dest || "").toUpperCase();
            if (origDest !== downDest) {
                errorDetails.push(`목적지 불일치(원본:[${origDest}] ↔ 전산Dest:[${downDest}])`);
                isError = true;
            }

            const downPortClean = (down.port || "").replace(/\s+/g, '').toUpperCase();
            const bukhangKeywords = ["WESTWOOD", "DPCT", "BPT", "HBCT", "PCT", "BICT"];
            const origFullText = (matchedOrig.remark + " " + (matchedOrig.adj1 || "") + (matchedOrig.adj2 || "")).toUpperCase();
            const isBukhangRequested = bukhangKeywords.some(kw => origFullText.includes(kw));
            if (isBukhangRequested) {
                if (!downPortClean.includes("KRPUS")) {
                    errorDetails.push(`출항지 오류(북항요청 -> Port:${downPortClean})`);
                    isError = true;
                }
            }

            const origCarrier = (matchedOrig.carrier || "").toUpperCase();
            const downCarrierCode = (down.carrierCode || "").toUpperCase();
            const downCarrierName = (down.carrierName || "").toUpperCase();
            carrierMatched = (origCarrier === downCarrierCode);
            if (!carrierMatched && carrierMap) {
                for (const [code, names] of Object.entries(carrierMap)) {
                    if ((origCarrier.includes(code) || names.some(n => origCarrier.includes(n.toUpperCase()))) &&
                        (downCarrierCode.includes(code) || names.some(n => downCarrierName.includes(n.toUpperCase())))) {
                        carrierMatched = true;
                        break;
                    }
                }
            }
            if (!carrierMatched) {
                errorDetails.push(`선사 불일치(원본:${matchedOrig.carrier} ↔ 전산:${down.carrierName})`);
                isError = true;
            }

            const sizeMap = { "HC": ["40HC", "HC"], "20": ["20FT", "20"], "40": ["40FT", "40"], "RF": ["40RH", "40RF", "RF"] };
            const origSize = (matchedOrig.cntrType || "").toUpperCase();
            const downSize = (down.cntrType || "").toUpperCase();
            sizeMatched = (origSize === downSize);
            if (!sizeMatched) {
                for (const [key, aliases] of Object.entries(sizeMap)) {
                    if (aliases.some(a => origSize.includes(a)) && aliases.some(a => downSize.includes(a))) {
                        sizeMatched = true;
                        break;
                    }
                }
            }
            if (!sizeMatched) {
                errorDetails.push(`컨테이너 불일치(원본:${matchedOrig.cntrType} ↔ 전산:${downSize})`);
                isError = true;
            }

            let origRemarkStr = (matchedOrig.remark || "").trim();
            let downRemarkStr = (down.remark || "").trim();
            let remarkMatched = (origRemarkStr === downRemarkStr);
            if (!remarkMatched && origRemarkStr) {
                let dRem = (down.remark || "").toUpperCase();
                let oRem = origRemarkStr.toUpperCase();
                if (oRem.length <= 10) {
                    if (dRem.includes(oRem)) remarkMatched = true;
                } else {
                    let start10 = oRem.substring(0, 10);
                    let midStart = Math.floor((oRem.length - 10) / 2);
                    let mid10 = oRem.substring(midStart, midStart + 10);
                    let end10 = oRem.slice(-10);
                    if (dRem.includes(start10) || dRem.includes(mid10) || dRem.includes(end10)) {
                        remarkMatched = true;
                    }
                }
            }
            if (!remarkMatched) {
                errorDetails.push(`리마크 불일치`);
                if (matchedOrig && !matchedOrig.tags?.some(t => t.text === "리마크 불일치")) {
                    matchedOrig.tags = matchedOrig.tags || [];
                    matchedOrig.tags.push({ text: "리마크 불일치", type: "warning" });
                }
            }
            if (!down.sealNo || down.sealNo === "") {
                errorDetails.push(`씰정보 누락`);
                isError = true;
            }
            if ((down.loadType || "").toUpperCase() !== "ODL") {
                errorDetails.push(`Load Type 오류(${down.loadType})`);
                isError = true;
            }

            const hasUnconditionalGood = matchedOrig && matchedOrig.tags && matchedOrig.tags.some(t => t.text.includes("무조건 양품"));
            if (hasUnconditionalGood && down.pendingQtySum > 0) {
                errorDetails.push(`<span style="color: #ef4444; font-weight: bold;">경고!팬딩장입작업중단</span>`);
                isError = true;
                if (!matchedOrig.tags.some(t => t.text === "팬딩중단")) {
                    matchedOrig.tags.push({ text: "팬딩중단", type: "danger" });
                }
            }

            if (isError) {
                stats.error++;
                if (rowBadge !== 'extra' && rowBadge !== 'missing') {
                    rowType = '오류 (불일치)';
                    rowClass = 'row-diff';
                    rowBadge = 'diff';
                }
            } else {
                stats.success++;
                if (down.loadQtySum === 0) { rowType = '대기'; rowBadge = 'pending'; }
                else if (down.loadQtySum >= down.planQtySum) { rowType = '완료'; rowBadge = 'success'; }
                else { rowType = '작업중'; rowBadge = 'progress'; }
                if (errorDetails.length === 0) errorDetails.push('');
            }
        }

        const prod = productMap.get((down.prodName || "").trim().toUpperCase());
        const dbWeight = prod ? (parseFloat(prod.weight) || 0) : 0;

        // [FIX] 제품구분: 모델명을 기준으로 마스터 데이터(prodType)에서 가져오되, 없으면 원본파일 정보 활용
        //단, 원본 G열의 값이 사업부 코드(3자리, Z로 종료: CVZ, CDZ 등) 이면 제품구분으로 취급하지 않음
        const dbProdType = prod ? (prod.prodType || "") : "";
        const origProdType = (matchedOrig && matchedOrig.prodType) ? matchedOrig.prodType : "";

        // 사업부 코드 식별 정규식 (3자리 대문자 + Z)
        const isDivisionCode = /^[A-Z]{2}Z$/i.test(origProdType) || ["DFZ"].includes(origProdType.toUpperCase());

        const masterProdType = (dbProdType && dbProdType !== "-")
            ? dbProdType
            : (matchedOrig && !isDivisionCode ? matchedOrig.prodType : "-");

        // [FIX] 사업부: 전산파일(A열)에 정보가 없으면 원본파일(G열) 정보 우선, 그 다음 마스터 정보 순으로 확인
        let finalDivision = down.division || (matchedOrig ? matchedOrig.prodType : "");
        if (!finalDivision || finalDivision === "-") {
            finalDivision = (dbProdType && dbProdType !== "-") ? dbProdType : "-";
        }

        let remainQty = down.remainQtySum; // 직접 추출한 잔여수량 사용
        let resultObj = {
            type: rowType,
            cntrNo: down.cntrNo,
            division: finalDivision,
            prodType: masterProdType,
            prodName: down.prodName,
            qtyInfo: {
                plan: down.planQtySum,
                load: down.loadQtySum,
                pending: down.pendingQtySum,
                remain: remainQty,
                packing: down.packingQtySum || 0,
                origPlan: matchedOrig ? matchedOrig.qtySum : null,
                isMismatch: matchedOrig && (matchedOrig.qtySum !== down.planQtySum)
            },
            cntrType: {
                val: down.cntrType || '-',
                orig: matchedOrig ? matchedOrig.cntrType : null,
                isMismatch: matchedOrig && !sizeMatched
            },
            carrierName: {
                val: normalizeCarrier ? normalizeCarrier(down.carrierName || down.carrierCode) : (down.carrierName || down.carrierCode),
                orig: matchedOrig ? (normalizeCarrier ? normalizeCarrier(matchedOrig.carrier) : matchedOrig.carrier) : null,
                isMismatch: matchedOrig && !carrierMatched
            },
            destination: {
                val: down.dest || '-',
                orig: matchedOrig ? matchedOrig.dest : null,
                isMismatch: matchedOrig && (origDest !== downDest)
            },
            detail: errorDetails.join(' | '),
            // [사용자 요청] 원본 리마크가 비어있거나(한글자 이내) 전산 리마크가 있는 경우 전산 리마크를 대신 사용
            origRemark: (() => {
                let r = matchedOrig ? (matchedOrig.remark || '') : (origCntrMap.get(cleanCntr) ? (origCntrMap.get(cleanCntr).remark || '') : '');
                if ((!r || r.trim().length <= 1) && downRemark && downRemark.trim().length > 1) {
                    return `(전산) ${downRemark}`;
                }
                return r || '없음';
            })(),
            adj1: matchedOrig ? (matchedOrig.adj1 || '') : '',
            adj1Color: matchedOrig ? (matchedOrig.adj1Color || null) : null,
            adj2: matchedOrig ? (matchedOrig.adj2 || '') : '',
            transporter: transporter,
            sealNo: down.sealNo || "",
            eta: matchedOrig ? (matchedOrig.eta || "") : "",
            etd: matchedOrig ? matchedOrig.etd : "",
            jobName: matchedOrig ? (matchedOrig.jobName || "") : "",
            workDate: (matchedOrig && matchedOrig.workDate) ? matchedOrig.workDate : workDateStr,
            loadPlanNo: down.loadPlanNo || (matchedOrig ? matchedOrig.loadPlanNo : ""),
            tags: matchedOrig ? (matchedOrig.tags || []) : [],
            cssClass: rowClass,
            badgeClass: rowBadge,
            isErrorRow: isError
        };

        // [사용자 추가 요청] 붉은색(danger) 태그가 있는 경우 자동으로 오류 탭으로 분류
        if (resultObj.tags && resultObj.tags.some(t => t.type === 'danger' || t.color === 'danger')) {
            resultObj.isErrorRow = true;
            // 태그명을 오류 상세 내역에도 추가 (중복 방지)
            const dangerTags = resultObj.tags
                .filter(t => t.type === 'danger' || t.color === 'danger')
                .map(t => t.text);

            let currentDetails = resultObj.detail ? resultObj.detail.split(' | ') : [];
            dangerTags.forEach(tagText => {
                if (!currentDetails.includes(tagText)) {
                    currentDetails.push(tagText);
                }
            });
            resultObj.detail = currentDetails.join(' | ');
        }

        const dims = [];
        if (prod) {
            if (prod.width) dims.push(prod.width);
            if (prod.depth) dims.push(prod.depth);
            if (prod.height) dims.push(prod.height);
        }

        resultObj.dims = dims.length > 0
            ? `${dims.join('×')} ${prod.cbm || 0}`
            : '-';

        let weightDown = down.loadQtySum > 0 ? (down.weightSum / down.loadQtySum) * down.planQtySum : 0;
        let weightOrig = matchedOrig ? (dbWeight * matchedOrig.qtySum) : 0;
        let weightMixed = dbWeight * down.planQtySum;

        resultObj.weights = {
            down: weightDown.toFixed(2),
            orig: weightOrig.toFixed(2),
            mixed: weightMixed.toFixed(2),
            isMismatch: Math.abs(weightOrig - weightMixed) >= 1
        };

        const isNonAsset = checkIsNonAsset(down.prodName, productMap);
        if (resultObj.weights.isMismatch && !isNonAsset) {
            isError = true;
            if (matchedOrig) errorDetails.push(`중량 불일치(원본:${weightOrig.toFixed(2)} ↔ 계획:${weightMixed.toFixed(2)})`);
            else errorDetails.push(`<span style="color: #ef4444; font-weight: bold;">신규품목중량발생(계획: ${weightMixed.toFixed(2)})</span>`);
            resultObj.detail = errorDetails.join(' | ');
            resultObj.isErrorRow = true;
        }

        if (prod) {
            resultObj.unitWeight = dbWeight;
            resultObj.unitCBM = parseFloat(prod.cbm) || 0;
            resultObj.width = prod.width || 0;
            resultObj.depth = prod.depth || 0;
            resultObj.height = prod.height || 0;
            // [사용자 핵심 오더] 중량 검증 로직 정밀화
            // 1. 계획수량(Plan)과 장입수량(K) 비교
            const planQty = down.planQtySum;
            const loadQty = down.loadQtySum;
            const loadWeight = down.weightSum; // M열 합계

            let actualSystemWeight = 0;
            if (loadQty === 0) {
                // 장입된 제품이 0일 경우 -> 마스터 중량 * 계획수량 (항상 같음)
                actualSystemWeight = dbWeight * planQty;
            } else if (Math.abs(planQty - loadQty) < 0.1) {
                // 모두 장입 시 -> 장입중량(M열) 그대로 사용
                actualSystemWeight = loadWeight;
            } else {
                // 일부 장입 시 -> (M/K) * 계획수량
                actualSystemWeight = (loadWeight / loadQty) * planQty;
            }

            const worksheetQty = matchedOrig ? matchedOrig.qtySum : 0;
            const expectedMasterWeight = dbWeight * worksheetQty; // 원본중량(마스터파일 * 원본수량)

            // 전산에서 계산한 개별 중량 (M/K)
            const downUnitWeight = loadQty > 0 ? (loadWeight / loadQty) : dbWeight;

            if (loadQty > 0 && Math.abs(downUnitWeight - dbWeight) > 0.05) {
                if (typeof weightMismatchSet !== 'undefined') weightMismatchSet.add((down.prodName || "").trim());
                resultObj.unitWeight = dbWeight;
                resultObj.currentUnitWeight = downUnitWeight;
                resultObj.prodName += ` (⚠️DB:${dbWeight}kg ↔ 현재:${downUnitWeight.toFixed(2)}kg)`;
                resultObj.cssClass = (resultObj.cssClass || "") + " row-update";
                resultObj.badgeClass = "update";
                resultObj.type = "제품정보 업데이트";
            }

            resultObj.weights = {
                orig: expectedMasterWeight,
                down: actualSystemWeight,
                mixed: actualSystemWeight,
                isMismatch: Math.abs(expectedMasterWeight - actualSystemWeight) > 1
            };
        } else if (!isNonAsset) {
            if (typeof missingProductsSet !== 'undefined') missingProductsSet.add((down.prodName || "").trim());
            resultObj.type = "제품정보 없음";
            resultObj.cssClass = (resultObj.cssClass || "") + " row-noproduct";
            resultObj.badgeClass = "noproduct";
            errorDetails.push(`<span style="color: #ef4444; font-weight: bold;">DB에 제품 정보 없음</span>`);
            resultObj.detail = errorDetails.join(' | ');
            isError = true;
            resultObj.isErrorRow = true;
            // 전산 중량이 0인데 수량은 있는 경우, DB 중량으로 보정하여 비교 (사용자 피드백 반영)
            const effectiveUnitWeight = (down.loadQtySum > 0)
                ? (down.weightSum / down.loadQtySum)
                : dbWeight;

            const actualDownWeight = effectiveUnitWeight * down.planQtySum;

            resultObj.weights = {
                orig: 0,
                down: actualDownWeight,
                mixed: actualDownWeight
            };
            resultObj.type = "원본누락";
            resultObj.cssClass = "row-extra";
            resultObj.badgeClass = "extra";
            resultObj.qtyInfo = { plan: down.planQtySum, origPlan: 0 };
        } else {
            resultObj.type = "정상(부)";
            resultObj.isErrorRow = isError;
        }
        resultObj.totalCBM = (prod && prod.cbm ? (prod.cbm * down.planQtySum).toFixed(2) : 0);
        resultObj.dims = prod ? `${prod.width}x${prod.depth}x${prod.height}` : "0x0x0";
        results.push(resultObj);
    });

    const origKeys = Object.keys(origGrouped);
    origKeys.forEach(key => {
        if (!downGrouped[key]) {
            const orig = origGrouped[key];
            const cleanCntr = (orig.cntrNo || "").trim().toUpperCase();
            const prodNameUpper = (orig.prodName || "").trim().toUpperCase();
            const prod = productMap.get(prodNameUpper);
            const isNonAsset = checkIsNonAsset(orig.prodName, productMap);

            let inheritedLoadPlanNo = "";
            for (const dKey in downGrouped) {
                if (dKey.startsWith(cleanCntr + "|")) {
                    inheritedLoadPlanNo = downGrouped[dKey].loadPlanNo;
                    if (inheritedLoadPlanNo) break;
                }
            }

            if (!isNonAsset) {
                stats.extra++;
                if (!prod && typeof missingProductsSet !== 'undefined') missingProductsSet.add((orig.prodName || "").trim());
            }

            results.push({
                type: isNonAsset ? '정상(부) - 전산없음' : '누락 (전산 파일)',
                cntrNo: orig.cntrNo,
                division: orig.prodType || '-', // 원본의 G열(사업부)
                prodType: prod ? (prod.prodType || '-') : (orig.prodType || '-'),
                prodName: orig.prodName,
                qtyInfo: { plan: orig.qtySum, load: 0, remain: orig.qtySum, packing: 0, origPlan: orig.qtySum, isMismatch: false },
                cntrType: { val: '-', orig: orig.cntrType, isMismatch: true },
                carrierName: {
                    val: '-',
                    orig: normalizeCarrier ? normalizeCarrier(orig.carrier) : orig.carrier,
                    isMismatch: true
                },
                destination: { val: '-', orig: orig.dest, isMismatch: true },
                detail: isNonAsset ? '' : `전산 파일에 해당 컨테이너/모델 정보 없음`,
                origRemark: orig.remark || '',
                adj1: orig.adj1 || '',
                adj2: orig.adj2 || '',
                workDate: (orig && orig.workDate) ? orig.workDate : workDateStr,
                transporter: isNonAsset ? orig.transporter : "미분류",
                tags: orig.tags || [],
                source: orig.source || "original",
                loadPlanNo: inheritedLoadPlanNo,
                cssClass: 'row-missing',
                badgeClass: 'missing',
                isErrorRow: !isNonAsset,
                unitWeight: parseFloat(prod?.weight || 0),
                unitCBM: parseFloat(prod?.cbm || 0),
                weights: {
                    down: "0.00",
                    orig: (parseFloat(prod?.weight || 0) * orig.qtySum).toFixed(2),
                    mixed: (parseFloat(prod?.weight || 0) * orig.qtySum).toFixed(2)
                },
                height: prod?.height || 0,
                totalCBM: (parseFloat(prod?.cbm || 0) * orig.qtySum).toFixed(2),
                dims: `${prod?.width || 0}x${prod?.depth || 0}x${prod?.height || 0}`,
                eta: orig.eta || "",
                etd: orig.etd || "",
                jobName: orig.jobName || ""
            });
        }
    });

    // 정렬 (Container Max LoadPlan DESC -> Cntr ASC -> Prod ASC)
    const cntrMaxPlan = {};
    results.forEach(r => {
        const c = r.cntrNo;
        const p = r.loadPlanNo || "";
        if (!cntrMaxPlan[c] || (p && p.localeCompare(cntrMaxPlan[c], undefined, { numeric: true }) > 0)) {
            cntrMaxPlan[c] = p;
        }
    });

    results.sort((a, b) => {
        const maxA = cntrMaxPlan[a.cntrNo] || "";
        const maxB = cntrMaxPlan[b.cntrNo] || "";
        const planComp = maxB.localeCompare(maxA, undefined, { numeric: true });
        if (planComp !== 0) return planComp;
        if (a.cntrNo < b.cntrNo) return -1;
        if (a.cntrNo > b.cntrNo) return 1;
        if (a.prodName < b.prodName) return -1;
        if (a.prodName > b.prodName) return 1;
        return 0;
    });

    stats.total = results.length;
    stats.updateRequired = (typeof missingProductsSet !== 'undefined' ? missingProductsSet.size : 0) + (typeof weightMismatchSet !== 'undefined' ? weightMismatchSet.size : 0);

    // 글로벌 stats도 업데이트 (브라우저 환경)
    if (typeof window !== 'undefined' && window.stats) {
        Object.assign(window.stats, stats);
    }

    return results;
}

// 브라우저에서 사용할 수 있도록 노출
if (typeof window !== 'undefined') {
    window.compareData = compareData;
    window.evaluateMathString = evaluateMathString;
    window.checkIsNonAsset = checkIsNonAsset;
}
