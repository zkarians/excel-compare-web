// --------------------------------------------------
// destination.js - 도착지(Destination / UN/LOCODE) 한국어 매핑 및 사전 관리 모듈
// --------------------------------------------------

let destinationMap = {};

// 전 세계 ISO 2자리 국가 코드 한국어 매핑 사전 (Fallback용)
const COUNTRY_CODE_MAP = {
    "AD": "안도라", "AE": "아랍에미리트", "AF": "아프가니스탄", "AG": "앤티가바부다", "AI": "앵귈라",
    "AL": "알바니아", "AM": "아르메니아", "AO": "앙골라", "AR": "아르헨티나", "AS": "아메리칸사모아",
    "AT": "오스트리아", "AU": "호주", "AW": "아루바", "AZ": "아제르바이잔", "BA": "보스니아",
    "BB": "바베이도스", "BD": "방글라데시", "BE": "벨기에", "BF": "부르키나파소", "BG": "불가리아",
    "BH": "바레인", "BI": "부룬디", "BJ": "베냉", "BM": "버뮤다", "BN": "브루나이", "BO": "볼리비아",
    "BR": "브라질", "BS": "바하마", "BT": "부탄", "BW": "보츠와나", "BY": "벨라루스", "BZ": "벨리즈",
    "CA": "캐나다", "CD": "콩고민주공화국", "CF": "중앙아프리카공화국", "CG": "콩고", "CH": "스위스",
    "CI": "코트디부아르", "CL": "칠레", "CM": "카메룬", "CN": "중국", "CO": "콜롬비아", "CR": "코스타리카",
    "CU": "쿠바", "CV": "카보베르데", "CY": "키프로스", "CZ": "체코", "DE": "독일", "DJ": "지부티",
    "DK": "덴마크", "DM": "도미니카연방", "DO": "도미니카공화국", "DZ": "알제리", "EC": "에콰도르",
    "EE": "에스토니아", "EG": "이집트", "ES": "스페인", "ET": "에티오피아", "FI": "핀란드", "FJ": "피지",
    "FR": "프랑스", "GA": "가봉", "GB": "영국", "GE": "조지아", "GH": "가나", "GM": "감비아",
    "GN": "기니", "GR": "그리스", "GT": "과테말라", "GU": "괌", "GY": "가이아나", "HK": "홍콩",
    "HN": "온두라스", "HR": "크로아티아", "HT": "아이티", "HU": "헝가리", "ID": "인도네시아", "IE": "아일랜드",
    "IL": "이스라엘", "IN": "인도", "IQ": "이라크", "IR": "이란", "IS": "아이슬란드", "IT": "이탈리아",
    "JM": "자메이카", "JO": "요르단", "JP": "일본", "KE": "케냐", "KG": "키르기스스탄", "KH": "캄보디아",
    "KR": "대한민국", "KW": "쿠웨이트", "KZ": "카자흐스탄", "LA": "라오스", "LB": "레바논", "LK": "스리랑카",
    "LR": "라이베리아", "LT": "리투아니아", "LU": "룩셈부르크", "LV": "라트비아", "LY": "리비아", "MA": "모로코",
    "MC": "모나코", "MD": "몰도바", "ME": "몬테네그로", "MG": "마다가스카르", "MK": "북마케도니아", "ML": "말리",
    "MM": "미얀마", "MN": "몽골", "MO": "마카오", "MR": "모리타니", "MT": "몰타", "MU": "모리셔스",
    "MV": "몰디브", "MX": "멕시코", "MY": "말레이시아", "MZ": "모잠비크", "NA": "나미비아", "NC": "뉴칼레도니아",
    "NG": "나이지리아", "NI": "니카라과", "NL": "네덜란드", "NO": "노르웨이", "NP": "네팔", "NZ": "뉴질랜드",
    "OM": "오만", "PA": "파나마", "PE": "페루", "PG": "파푸아뉴기니", "PH": "필리핀", "PK": "파키스탄",
    "PL": "폴란드", "PT": "포르투갈", "PY": "파라과이", "QA": "카타르", "RO": "루마니아", "RS": "세르비아",
    "RU": "러시아", "SA": "사우디아라비아", "SD": "수단", "SE": "스웨덴", "SG": "싱가포르", "SI": "슬로베니아",
    "SK": "슬로바키아", "SL": "시에라리온", "SN": "세네갈", "SO": "소말리아", "SR": "수리남", "SV": "엘살바도르",
    "SY": "시리아", "TG": "토고", "TH": "태국", "TN": "튀니지", "TR": "튀르키예", "TT": "트리니다드토바고",
    "TW": "대만", "TZ": "탄자니아", "UA": "우크라이나", "UG": "우간다", "US": "미국", "UY": "우루과이",
    "UZ": "우즈베키스탄", "VE": "베네수엘라", "VN": "베트남", "ZA": "남아프리카공화국", "ZM": "잠비아", "ZW": "짐바브웨"
};

// 1. 기본 목적지 코드 (UN/LOCODE 및 물류 거점) 기본 사전 데이터 (전수 등록)
const DEFAULT_DESTINATION_MAP = {
    // 아랍에미리트 (UAE)
    "AEAJM": { kr: "아랍에미리트 아지만", en: "Ajman, UAE" },
    "AEJEA": { kr: "아랍에미리트 제벨 알리", en: "Jebel Ali, UAE" },
    "AEDXB": { kr: "아랍에미리트 두바이", en: "Dubai, UAE" },
    "AEAUH": { kr: "아랍에미리트 아부다비", en: "Abu Dhabi, UAE" },

    // 알바니아
    "ALTIA": { kr: "알바니아 티라나 / 두러스", en: "Tirana / Durres, Albania" },

    // 아르헨티나
    "ARBUE": { kr: "아르헨티나 부에노스아이레스", en: "Buenos Aires, Argentina" },

    // 호주 (AU)
    "AUBNE": { kr: "호주 브리즈번", en: "Brisbane, Australia" },
    "AUFRE": { kr: "호주 프리맨틀 (퍼스)", en: "Fremantle (Perth), Australia" },
    "AUMEL": { kr: "호주 멜버른", en: "Melbourne, Australia" },
    "AUSYD": { kr: "호주 시드니", en: "Sydney, Australia" },
    "AUADL": { kr: "호주 애들레이드", en: "Adelaide, Australia" },

    // 보스니아 헤르체고비나
    "BAHDC": { kr: "보스니아 헤르체고비나 하디치", en: "Hadzici / Ploce, Bosnia" },

    // 불가리아
    "BGBLN": { kr: "불가리아 벨레네 / 바르나", en: "Belene / Varna, Bulgaria" },
    "BGBOZ": { kr: "불가리아 보조리슈테 (소피아)", en: "Bozhurishte (Sofia), Bulgaria" },
    "BGS03": { kr: "불가리아 소피아 물류센터", en: "Sofia Hub, Bulgaria" },
    "BGS04": { kr: "불가리아 바르나 / 부르가스", en: "Varna / Burgas, Bulgaria" },

    // 베냉
    "BJCOO": { kr: "베냉 코토누", en: "Cotonou, Benin" },

    // 브루나이
    "BNMUA": { kr: "브루나이 무아라", en: "Muara, Brunei" },

    // 브라질 (BR)
    "BRIOA": { kr: "브라질 리오그란데", en: "Rio Grande, Brazil" },
    "BRRIG": { kr: "브라질 리오그란데", en: "Rio Grande, Brazil" },
    "BRSSZ": { kr: "브라질 산투스 (상파울루)", en: "Santos (Sao Paulo), Brazil" },
    "BRITJ": { kr: "브라질 이타자이", en: "Itajai, Brazil" },
    "BRNVT": { kr: "브라질 나베간치스", en: "Navegantes, Brazil" },

    // 벨라루스
    "BYMS0": { kr: "벨라루스 민스크 물류센터", en: "Minsk Hub, Belarus" },
    "BYMSQ": { kr: "벨라루스 민스크", en: "Minsk, Belarus" },

    // 캐나다 (CA)
    "CABRP": { kr: "캐나다 온타리오 브램턴", en: "Brampton, ON, Canada" },
    "CACDC": { kr: "캐나다 캘거리 물류센터", en: "Calgary Hub, AB, Canada" },
    "CACNC": { kr: "캐나다 캘거리", en: "Calgary, AB, Canada" },
    "CADEL": { kr: "캐나다 델타 (밴쿠버)", en: "Delta (Vancouver), BC, Canada" },
    "CADL4": { kr: "캐나다 델타 물류터미널", en: "Delta Terminal, BC, Canada" },
    "CAMIS": { kr: "캐나다 토론토 미시사가", en: "Mississauga (Toronto), ON, Canada" },
    "CANY2": { kr: "캐나다 몬트리올 / 퀘벡 거점", en: "Montreal/Quebec, Canada" },
    "CANYK": { kr: "캐나다 몬트리올", en: "Montreal, QC, Canada" },
    "CASLA": { kr: "캐나다 퀘벡 세인트로랑", en: "Saint-Laurent, QC, Canada" },
    "CAWNP": { kr: "캐나다 위니펙", en: "Winnipeg, MB, Canada" },
    "CAVAN": { kr: "캐나다 밴쿠버", en: "Vancouver, BC, Canada" },
    "CATOH": { kr: "캐나다 토론토", en: "Toronto, ON, Canada" },

    // 칠레 (CL)
    "CLSAI": { kr: "칠레 산안토니오", en: "San Antonio, Chile" },
    "CLSCL": { kr: "칠레 산티아고", en: "Santiago, Chile" },
    "CLVAP": { kr: "칠레 발파라이소", en: "Valparaiso, Chile" },

    // 카메룬
    "CMDLA": { kr: "카메룬 두알라", en: "Douala, Cameroon" },

    // 중국 (CN)
    "CNNKG": { kr: "중국 난징 (남경)", en: "Nanjing, China" },
    "CNSHA": { kr: "중국 상하이 (상해)", en: "Shanghai, China" },
    "CNNBO": { kr: "중국 닝보 (영파)", en: "Ningbo, China" },
    "CNTAO": { kr: "중국 칭다오 (청도)", en: "Qingdao, China" },

    // 콜롬비아 (CO)
    "COBUN": { kr: "콜롬비아 부에나벤투라", en: "Buenaventura, Colombia" },
    "COCTG": { kr: "콜롬비아 카르타헤나", en: "Cartagena, Colombia" },

    // 코스타리카 (CR)
    "CRCYL": { kr: "코스타리카 푸에르토칼데라", en: "Puerto Caldera, Costa Rica" },

    // 독일 (DE)
    "DEBRV": { kr: "독일 브레머하펜", en: "Bremerhaven, Germany" },
    "DEHAM": { kr: "독일 함부르크", en: "Hamburg, Germany" },

    // 덴마크 (DK)
    "DKBR1": { kr: "덴마크 브뢴뷔 (코펜하겐)", en: "Brondby (Copenhagen), Denmark" },

    // 도미니카공화국 (DO)
    "DOCDO": { kr: "도미니카공화국 카우세도", en: "Caucedo, Dominican Republic" },

    // 알제리 (DZ)
    "DZAAE": { kr: "알제리 안나바", en: "Annaba, Algeria" },
    "DZALG": { kr: "알제리 알제", en: "Algiers, Algeria" },

    // 에콰도르 (EC)
    "ECGYE": { kr: "에콰도르 과야킬", en: "Guayaquil, Ecuador" },

    // 이집트 (EG)
    "EGPSD": { kr: "이집트 포트사이드", en: "Port Said, Egypt" },
    "EGALY": { kr: "이집트 알렉산드리아", en: "Alexandria, Egypt" },

    // 스페인 (ES)
    "ESBCN": { kr: "스페인 바르셀로나", en: "Barcelona, Spain" },
    "ESGU2": { kr: "스페인 과달라하라 물류거점", en: "Guadalajara Hub, Spain" },
    "ESVLC": { kr: "스페인 발렌시아", en: "Valencia, Spain" },

    // 핀란드 (FI)
    "FIVAT": { kr: "핀란드 반타 (헬싱키)", en: "Vantaa (Helsinki), Finland" },

    // 피지 (FJ)
    "FJSUV": { kr: "피지 수바", en: "Suva, Fiji" },

    // 프랑스 (FR)
    "FRFOS": { kr: "프랑스 포스 (마르세유)", en: "Fos-sur-Mer (Marseille), France" },
    "FRSRV": { kr: "프랑스 르아브르 / 생나제르", en: "Le Havre / Saint-Nazaire, France" },

    // 영국 (GB)
    "GBLTT": { kr: "영국 런던 게이트웨이", en: "London Gateway, UK" },
    "GBFXT": { kr: "영국 펠릭스토우", en: "Felixstowe, UK" },
    "GBSOU": { kr: "영국 사우샘프턴", en: "Southampton, UK" },

    // 조지아 (GE)
    "GEPTI": { kr: "조지아 포티", en: "Poti, Georgia" },
    "GETBS": { kr: "조지아 트빌리시", en: "Tbilisi, Georgia" },

    // 가나 (GH)
    "GHTEM": { kr: "가나 테마", en: "Tema, Ghana" },

    // 그리스 (GR)
    "GRELE": { kr: "그리스 엘레우시스 (아테네)", en: "Eleusis (Athens), Greece" },
    "GRPIR": { kr: "그리스 피레우스", en: "Piraeus, Greece" },

    // 과테말라 (GT)
    "GTPRQ": { kr: "과테말라 푸에르토케찰", en: "Puerto Quetzal, Guatemala" },

    // 홍콩 (HK)
    "HKHKG": { kr: "홍콩", en: "Hong Kong, HK" },

    // 온두라스 (HN)
    "HNART": { kr: "온두라스 아라메시나 / 푸에르토코르테스", en: "Aramesina / Puerto Cortes, Honduras" },
    "HNSAP": { kr: "온두라스 산페드로술라", en: "San Pedro Sula, Honduras" },

    // 크로아티아 (HR)
    "HRZA3": { kr: "크로아티아 자그레브 물류거점", en: "Zagreb Hub, Croatia" },
    "HRZAA": { kr: "크로아티아 자그레브", en: "Zagreb, Croatia" },

    // 헝가리 (HU)
    "HUECR": { kr: "헝가리 에체르 (부다페스트)", en: "Ecser (Budapest), Hungary" },
    "HUSZ2": { kr: "헝가리 세게드 / 사스할롬바타", en: "Szeged / Szazhalombatta, Hungary" },
    "HUUL3": { kr: "헝가리 울뢰 물류센터", en: "Ullo Logistics Hub, Hungary" },

    // 인도네시아 (ID)
    "IDCAK": { kr: "인도네시아 자카르타 찌까랑", en: "Cikarang (Jakarta), Indonesia" },
    "IDJKT": { kr: "인도네시아 자카르타", en: "Jakarta, Indonesia" },

    // 이스라엘 (IL)
    "ILASH": { kr: "이스라엘 아쉬도드", en: "Ashdod, Israel" },
    "ILHFA": { kr: "이스라엘 하이파", en: "Haifa, Israel" },

    // 인도 (IN)
    "INMAA": { kr: "인도 첸나이 (마드라스)", en: "Chennai, India" },
    "INNSA": { kr: "인도 나바셰바 (뭄바이)", en: "Nhava Sheva (Mumbai), India" },
    "INVIS": { kr: "인도 비사카파트남", en: "Visakhapatnam, India" },

    // 이탈리아 (IT)
    "ITCNG": { kr: "이탈리아 코넬리아노", en: "Conegliano, Italy" },
    "ITVCE": { kr: "이탈리아 베니스 (베네치아)", en: "Venice, Italy" },
    "ITGOA": { kr: "이탈리아 제노바", en: "Genoa, Italy" },

    // 자메이카 (JM)
    "JMKIN": { kr: "자메이카 킹스턴", en: "Kingston, Jamaica" },

    // 요르단 (JO)
    "JOAQJ": { kr: "요르단 아카바", en: "Aqaba, Jordan" },

    // 일본 (JP)
    "JPKWS": { kr: "일본 가와사키", en: "Kawasaki, Japan" },
    "JPTYO": { kr: "일본 도쿄", en: "Tokyo, Japan" },
    "JPYOK": { kr: "일본 요코하마", en: "Yokohama, Japan" },
    "JPOSA": { kr: "일본 오사카", en: "Osaka, Japan" },

    // 케냐 (KE)
    "KEEMB": { kr: "케냐 엠바카시 (나이로비)", en: "Embakasi (Nairobi), Kenya" },
    "KEMBA": { kr: "케냐 몸바사", en: "Mombasa, Kenya" },

    // 캄보디아 (KH)
    "KHSIH": { kr: "캄보디아 시아누크빌", en: "Sihanoukville, Cambodia" },

    // 카자흐스탄 (KZ)
    "KZALA": { kr: "카자흐스탄 알마티", en: "Almaty, Kazakhstan" },

    // 레바논 (LB)
    "LBBEY": { kr: "레바논 베이루트", en: "Beirut, Lebanon" },

    // 스리랑카 (LK)
    "LKCMB": { kr: "스리랑카 콜롬보", en: "Colombo, Sri Lanka" },

    // 리투아니아 (LT)
    "LTAYS": { kr: "리투아니아 빌뉴스 / 클라이페다", en: "Vilnius / Klaipeda, Lithuania" },

    // 리비아 (LY)
    "LYBEN": { kr: "리비아 벵가지", en: "Benghazi, Libya" },
    "LYMRA": { kr: "리비아 미스라타", en: "Misurata, Libya" },

    // 모로코 (MA)
    "MATIT": { kr: "모로코 테투안 / 탕헤르", en: "Tetouan / Tangier, Morocco" },

    // 몬테네그로 (ME)
    "METGD": { kr: "몬테네그로 포드고리차 / 바르", en: "Podgorica / Bar, Montenegro" },

    // 북마케도니아 (MK)
    "MKKO1": { kr: "북마케도니아 스코페 거점", en: "Skopje Hub, North Macedonia" },
    "MKPTR": { kr: "북마케도니아 페트로베츠", en: "Petrovec, North Macedonia" },

    // 몽골 (MN)
    "MNULN": { kr: "몽골 울란바토르", en: "Ulaanbaatar, Mongolia" },

    // 모리셔스 (MU)
    "MUPLU": { kr: "모리셔스 포트루이스", en: "Port Louis, Mauritius" },

    // 멕시코 (MX)
    "MXMEX": { kr: "멕시코 멕시코시티 / 만사니요", en: "Mexico City / Manzanillo, Mexico" },
    "MXZLO": { kr: "멕시코 만사니요", en: "Manzanillo, Mexico" },
    "MXLZC": { kr: "멕시코 라자로카르데나스", en: "Lazaro Cardenas, Mexico" },

    // 말레이시아 (MY)
    "MYPKG": { kr: "말레이시아 포트클랑", en: "Port Klang, Malaysia" },
    "MYTPP": { kr: "말레이시아 탄중펠레파스", en: "Tanjung Pelepas, Malaysia" },

    // 나이지리아 (NG)
    "NGAPP": { kr: "나이지리아 아파파 (라고스)", en: "Apapa (Lagos), Nigeria" },

    // 네덜란드 (NL)
    "NLTLB": { kr: "네덜란드 틸뷔르흐 / 로테르담", en: "Tilburg / Rotterdam, Netherlands" },
    "NLRTM": { kr: "네덜란드 로테르담", en: "Rotterdam, Netherlands" },

    // 뉴질랜드 (NZ)
    "NZAKL": { kr: "뉴질랜드 오클랜드", en: "Auckland, New Zealand" },

    // 오만 (OM)
    "OMSOH": { kr: "오만 소하르", en: "Sohar, Oman" },

    // 파나마 (PA)
    "PABLB": { kr: "파나마 발보아", en: "Balboa, Panama" },
    "PACFZ": { kr: "파나마 콜론 자유무역지대", en: "Colon Free Zone, Panama" },

    // 페루 (PE)
    "PECLL": { kr: "페루 카야오 (리마)", en: "Callao (Lima), Peru" },

    // 필리핀 (PH)
    "PHMNL": { kr: "필리핀 마닐라", en: "Manila, Philippines" },

    // 폴란드 (PL)
    "PLGDN": { kr: "폴란드 그단스크", en: "Gdansk, Poland" },
    "PLKY0": { kr: "폴란드 믈와바 / 바르샤바 거점", en: "Mlawa/Warsaw Hub, Poland" },
    "PLKY2": { kr: "폴란드 브로츠와프 물류센터", en: "Wroclaw Hub, Poland" },
    "PLKY3": { kr: "폴란드 카토비체 물류센터", en: "Katowice Hub, Poland" },
    "PLKY4": { kr: "폴란드 포즈난 물류센터", en: "Poznan Hub, Poland" },
    "PLKYW": { kr: "폴란드 바르샤바", en: "Warsaw, Poland" },
    "PLMSO": { kr: "폴란드 믈와바 공장/물류센터", en: "Mlawa LG Complex, Poland" },

    // 포르투갈 (PT)
    "PTAZA": { kr: "포르투갈 아잠부자 (리스본)", en: "Azambuja (Lisbon), Portugal" },

    // 카타르 (QA)
    "QAHMD": { kr: "카타르 하마드 (도하)", en: "Hamad (Doha), Qatar" },

    // 레위니옹 (RE)
    "REPDG": { kr: "프랑스령 레위니옹 포앵트데갈레", en: "Pointe des Galets, Reunion" },

    // 루마니아 (RO)
    "ROGRG": { kr: "루마니아 지우르지우 (콘스탄차)", en: "Giurgiu / Constanta, Romania" },

    // 세르비아 (RS)
    "RSNV0": { kr: "세르비아 노비사드 (베오그라드)", en: "Novi Sad / Belgrade, Serbia" },

    // 사우디아라비아 (SA)
    "SADMN": { kr: "사우디아라비아 담맘", en: "Dammam, Saudi Arabia" },
    "SAJED": { kr: "사우디아라비아 제다", en: "Jeddah, Saudi Arabia" },

    // 스웨덴 (SE)
    "SEEKT": { kr: "스웨덴 예테보리 / 스톡홀름", en: "Gothenburg / Stockholm, Sweden" },
    "SEJKG": { kr: "스웨덴 옌셰핑 물류센터", en: "Jonkoping Hub, Sweden" },

    // 싱가포르 (SG)
    "SGSIN": { kr: "싱가포르", en: "Singapore, SG" },

    // 슬로베니아 (SI)
    "SINOG": { kr: "슬로베니아 노바고리차 / 코페르", en: "Nova Gorica / Koper, Slovenia" },
    "SIKOP": { kr: "슬로베니아 코페르", en: "Koper, Slovenia" },

    // 시에라리온 (SL)
    "SLFNA": { kr: "시에라리온 프리타운", en: "Freetown, Sierra Leone" },

    // 세네갈 (SN)
    "SNDKR": { kr: "세네갈 다카르", en: "Dakar, Senegal" },

    // 소말리아 (SO)
    "SOBBO": { kr: "소말리아 베르베라 / 보사소", en: "Berbera / Bosaso, Somalia" },

    // 토고 (TG)
    "TGLFW": { kr: "토고 로메", en: "Lome, Togo" },

    // 태국 (TH)
    "THCHB": { kr: "태국 람차방 / 촌부리", en: "Laem Chabang / Chonburi, Thailand" },
    "THRYG": { kr: "태국 라용 물류거점", en: "Rayong, Thailand" },
    "THBKK": { kr: "태국 방콕", en: "Bangkok, Thailand" },

    // 튀니지 (TN)
    "TNRDS": { kr: "튀니지 라데스 (튀니스)", en: "Rades (Tunis), Tunisia" },

    // 튀르키예 (TR)
    "TRGEB": { kr: "튀르키예 게브제 (이스탄불)", en: "Gebze (Istanbul), Turkey" },
    "TRMER": { kr: "튀르키예 메르신", en: "Mersin, Turkey" },
    "TRTUZ": { kr: "튀르키예 투즐라 (이스탄불)", en: "Tuzla (Istanbul), Turkey" },

    // 대만 (TW)
    "TWKEL": { kr: "대만 기륭 (타이베이)", en: "Keelung (Taipei), Taiwan" },
    "TWKHH": { kr: "대만 가오슝", en: "Kaohsiung, Taiwan" },

    // 탄자니아 (TZ)
    "TZDAR": { kr: "탄자니아 다르에스살람", en: "Dar es Salaam, Tanzania" },

    // 미국 (US) - 주요 항구 및 물류센터 전수 매핑
    "USATL": { kr: "미국 조지아 애틀랜타", en: "Atlanta, GA, USA" },
    "USAUC": { kr: "미국 조지아 오거스타", en: "Augusta, GA, USA" },
    "USBFA": { kr: "미국 텍사스 버팔로 / 포트워스", en: "Buffalo / Fort Worth, TX, USA" },
    "USBJX": { kr: "미국 잭슨빌 물류센터", en: "Jacksonville Hub, FL, USA" },
    "USBMV": { kr: "미국 텍사스 브라운스빌", en: "Brownsville, TX, USA" },
    "USBNC": { kr: "미국 노스캐롤라이나 번스빌", en: "Burnsville, NC, USA" },
    "USBNK": { kr: "미국 뉴욕 버뱅크 / 브루클린", en: "Burbank / Brooklyn, NY, USA" },
    "USBQI": { kr: "미국 오하이오 볼링그린", en: "Bowling Green, OH, USA" },
    "USBUH": { kr: "미국 텍사스 부시 인터콘티넨탈 / 휴스턴", en: "Houston Area, TX, USA" },
    "USCLT": { kr: "미국 노스캐롤라이나 샬럿", en: "Charlotte, NC, USA" },
    "USCMH": { kr: "미국 오하이오 콜럼버스", en: "Columbus, OH, USA" },
    "USCMT": { kr: "미국 오하이오 콜럼버스 RDC", en: "Columbus RDC, OH, USA" },
    "USDNK": { kr: "미국 텍사스 댈러스/포트워스", en: "Dallas Area, TX, USA" },
    "USDNN": { kr: "미국 텍사스 댈러스 북부 물류센터", en: "Dallas North Hub, TX, USA" },
    "USDOT": { kr: "미국 앨라배마 도단", en: "Dothan, AL, USA" },
    "USEHT": { kr: "미국 뉴저지 에그하버", en: "Egg Harbor, NJ, USA" },
    "USEWV": { kr: "미국 웨스트버지니아 물류센터", en: "East West Virginia Hub, USA" },
    "USFLN": { kr: "미국 미시간 플린트", en: "Flint, MI, USA" },
    "USFON": { kr: "미국 캘리포니아 폰타나", en: "Fontana, CA, USA" },
    "USFSD": { kr: "미국 사우스다코타 수폴스", en: "Sioux Falls, SD, USA" },
    "USFWM": { kr: "미국 텍사스 포트워스", en: "Fort Worth, TX, USA" },
    "USGBO": { kr: "미국 노스캐롤라이나 그린스버러", en: "Greensboro, NC, USA" },
    "USGRX": { kr: "미국 조지아 물류센터", en: "Georgia Regional Hub, GA, USA" },
    "USGVP": { kr: "미국 사우스캐롤라이나 그린빌", en: "Greenville, SC, USA" },
    "USGYR": { kr: "미국 애리조나 굿이어 (피닉스)", en: "Goodyear (Phoenix), AZ, USA" },
    "USHNZ": { kr: "미국 조지아 하인스빌 (사바나)", en: "Hinesville (Savannah), GA, USA" },
    "USLAL": { kr: "미국 플로리다 레이클랜드", en: "Lakeland, FL, USA" },
    "USLAX": { kr: "미국 캘리포니아 로스앤젤레스 / 롱비치", en: "Los Angeles / Long Beach, CA, USA" },
    "USLOT": { kr: "미국 일리노이 록포트 (시카고)", en: "Lockport (Chicago), IL, USA" },
    "USLTX": { kr: "미국 텍사스 라레도 국경물류센터", en: "Laredo Cross-border Hub, TX, USA" },
    "USMC5": { kr: "미국 테네시 멤피스 물류센터", en: "Memphis Center, TN, USA" },
    "USMDE": { kr: "미국 텍사스 맥앨런", en: "McAllen, TX, USA" },
    "USMES": { kr: "미국 텍사스 메스키트 (댈러스)", en: "Mesquite (Dallas), TX, USA" },
    "USMQY": { kr: "미국 테네시 스머나 (내슈빌)", en: "Smyrna (Nashville), TN, USA" },
    "USMSC": { kr: "미국 사우스캐롤라이나 찰스턴", en: "Charleston, SC, USA" },
    "USMSW": { kr: "미국 워싱턴주 모지스레이크", en: "Moses Lake, WA, USA" },
    "USMTA": { kr: "미국 조지아 머리에타 (애틀랜타)", en: "Marietta (Atlanta), GA, USA" },
    "USMTR": { kr: "미국 텍사스 마샬", en: "Marshall, TX, USA" },
    "USMV4": { kr: "미국 캘리포니아 모레노밸리", en: "Moreno Valley, CA, USA" },
    "USN3U": { kr: "미국 뉴저지 / 뉴욕 동부 물류센터", en: "NJ/NY East Coast Hub, USA" },
    "USN5W": { kr: "미국 노스캐롤라이나 윌밍턴", en: "Wilmington, NC, USA" },
    "USN5Y": { kr: "미국 뉴욕 메트로 물류거점", en: "New York Metro Hub, NY, USA" },
    "USN8H": { kr: "미국 테네시 내슈빌 거점", en: "Nashville Hub, TN, USA" },
    "USNAN": { kr: "미국 텍사스 샌안토니오", en: "San Antonio, TX, USA" },
    "USNBU": { kr: "미국 텍사스 뉴브라운펠스", en: "New Braunfels, TX, USA" },
    "USNCY": { kr: "미국 캔자스 캔자스시티", en: "Kansas City, KS/MO, USA" },
    "USNLW": { kr: "미국 캘리포니아 오클랜드 / 샌프란시스코", en: "Oakland / SF Bay, CA, USA" },
    "USOCF": { kr: "미국 플로리다 오칼라", en: "Ocala, FL, USA" },
    "USONT": { kr: "미국 캘리포니아 온타리오 (LA 근교)", en: "Ontario (LA Area), CA, USA" },
    "USP3K": { kr: "미국 펜실베이니아 필라델피아 물류센터", en: "Philadelphia Center, PA, USA" },
    "USPCI": { kr: "미국 캘리포니아 피코리베라 (LA)", en: "Pico Rivera (LA), CA, USA" },
    "USPIL": { kr: "미국 일리노이 피오리아", en: "Peoria, IL, USA" },
    "USPIT": { kr: "미국 펜실베이니아 피츠버그", en: "Pittsburgh, PA, USA" },
    "USREQ": { kr: "미국 일리노이 시카고 엘우드 물류센터", en: "Elwood (Chicago), IL, USA" },
    "USRIC": { kr: "미국 버지니아 리치먼드", en: "Richmond, VA, USA" },
    "USRIK": { kr: "미국 텍사스 리처드슨", en: "Richardson, TX, USA" },
    "USSAV": { kr: "미국 조지아 사바나", en: "Savannah, GA, USA" },
    "USSCK": { kr: "미국 캘리포니아 스톡턴", en: "Stockton, CA, USA" },
    "USSLC": { kr: "미국 유타 솔트레이크시티", en: "Salt Lake City, UT, USA" },
    "USSOJ": { kr: "미국 뉴저지 사우스오렌지", en: "South Orange, NJ, USA" },
    "USSQN": { kr: "미국 펜실베이니아 서스퀘하나", en: "Susquehanna, PA, USA" },
    "USSRX": { kr: "미국 텍사스 슈거랜드 (휴스턴)", en: "Sugar Land (Houston), TX, USA" },
    "USSSG": { kr: "미국 캘리포니아 사우스샌프란시스코", en: "South San Francisco, CA, USA" },
    "USSWY": { kr: "미국 뉴욕 시러큐스", en: "Syracuse, NY, USA" },
    "USTBP": { kr: "미국 플로리다 탬파", en: "Tampa, FL, USA" },
    "USTIW": { kr: "미국 워싱턴주 터코마 (시애틀)", en: "Tacoma (Seattle), WA, USA" },
    "USTRC": { kr: "미국 캘리포니아 트레이시 물류센터", en: "Tracy Logistics Center, CA, USA" },
    "USTUW": { kr: "미국 워싱턴주 턱윌라 (시애틀)", en: "Tukwila (Seattle), WA, USA" },
    "USTWP": { kr: "미국 뉴저지 타운십", en: "Township Center, NJ, USA" },
    "USTXW": { kr: "미국 텍사스 워스 (댈러스)", en: "Texas Worth Area, TX, USA" },
    "USTYR": { kr: "미국 텍사스 타일러", en: "Tyler, TX, USA" },
    "USUSB": { kr: "미국 인디애나폴리스 물류센터", en: "Indianapolis Hub, IN, USA" },
    "USWQW": { kr: "미국 조지아주 물류 RDC", en: "Georgia Regional RDC, USA" },
    "USCHI": { kr: "미국 일리노이 시카고", en: "Chicago, IL, USA" },
    "USHOU": { kr: "미국 텍사스 휴스턴", en: "Houston, TX, USA" },
    "USNYC": { kr: "미국 뉴욕", en: "New York, NY, USA" },
    "USSEA": { kr: "미국 워싱턴 시애틀", en: "Seattle, WA, USA" },

    // 베네수엘라 (VE)
    "VELAG": { kr: "베네수엘라 라과이라 (카라카스)", en: "La Guaira (Caracas), Venezuela" },
    "VEPBL": { kr: "베네수엘라 푸에르토카베요", en: "Puerto Cabello, Venezuela" },

    // 베트남 (VN)
    "VNHPH": { kr: "베트남 하이퐁", en: "Hai Phong, Vietnam" },
    "VNSGN": { kr: "베트남 호치민 (사이공)", en: "Ho Chi Minh (Saigon), Vietnam" },
    "VNDAD": { kr: "베트남 다낭", en: "Da Nang, Vietnam" },

    // 남아프리카공화국 (ZA)
    "ZADUR": { kr: "남아프리카공화국 더반", en: "Durban, South Africa" },
    "ZACPT": { kr: "남아프리카공화국 케이프타운", en: "Cape Town, South Africa" },
    "ZAPLZ": { kr: "남아프리카공화국 포트엘리자베스", en: "Port Elizabeth, South Africa" }
};

/**
 * 목적지 사전 로드 (DB 및 로컬스토리지 연동)
 */
async function loadDestinationMap() {
    destinationMap = Object.assign({}, DEFAULT_DESTINATION_MAP);

    try {
        if (typeof API_BASE !== 'undefined') {
            const response = await fetch(`${API_BASE}/api/sync/destinations`);
            if (response.ok) {
                const data = await response.json();
                if (data.success && data.mapping && Object.keys(data.mapping).length > 0) {
                    destinationMap = Object.assign(destinationMap, data.mapping);
                    return;
                }
            }
        }
    } catch (err) {
        console.warn("DB 목적지 사전 로드 실패 (로컬 데이터 유지):", err);
    }

    const saved = localStorage.getItem('destinationMapPrefs');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            destinationMap = Object.assign(destinationMap, parsed);
        } catch (e) {
            console.error("로컬 목적지 캐시 파싱 실패:", e);
        }
    }
}

/**
 * 커스텀 목적지 저장 (로컬스토리지 + 서버 동기화)
 */
async function saveDestinationMap() {
    localStorage.setItem('destinationMapPrefs', JSON.stringify(destinationMap));
    try {
        if (typeof API_BASE !== 'undefined') {
            await fetch(`${API_BASE}/api/sync/destinations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mapping: destinationMap })
            });
        }
    } catch (err) {
        console.error("DB 목적지 동기화 실패:", err);
    }
}

/**
 * 5자리 목적지 코드로 한국어 위치 정보 조회 (미등록 코드 자동 국가 분석 Fallback 내장)
 * @param {string} code 
 * @returns {{ text: string, kr: string, en: string, isKnown: boolean }}
 */
function getDestinationInfo(code) {
    if (!code || code === '-' || code.trim() === '') {
        return { text: '-', kr: '-', en: '-', isKnown: false };
    }

    const cleanCode = code.trim().toUpperCase();

    // 1. 등록된 사전에서 조회
    if (destinationMap[cleanCode]) {
        const item = destinationMap[cleanCode];
        const kr = typeof item === 'string' ? item : item.kr;
        const en = typeof item === 'string' ? '' : (item.en || '');
        const displayText = en ? `${kr} (${en})` : kr;
        return { text: displayText, kr, en, isKnown: true };
    }

    // 2. 미등록 코드인 경우: 2자리 ISO 국가 코드 자동 분석 (Fallback)
    const countryCode = cleanCode.substring(0, 2);
    const countryName = COUNTRY_CODE_MAP[countryCode];

    if (countryName) {
        const fallbackKr = `[${countryName}] ${cleanCode}`;
        const fallbackEn = `${countryCode} Area`;
        return {
            text: `${fallbackKr} (${fallbackEn})`,
            kr: fallbackKr,
            en: fallbackEn,
            isKnown: false
        };
    }

    // 3. 국가코드조차 알 수 없는 경우
    return {
        text: `[미확인 목적지] ${cleanCode}`,
        kr: `미확인 목적지 (${cleanCode})`,
        en: cleanCode,
        isKnown: false
    };
}

/**
 * 도착지 HTML 렌더링 헬퍼 (마우스 호버 툴팁 및 더블클릭 수정 연동)
 */
function renderDestinationHtml(orig, val, isMismatch) {
    const valInfo = getDestinationInfo(val);
    const origInfo = getDestinationInfo(orig);

    const makeSpan = (code, info) => {
        if (!code || code === '-') return `<span>-</span>`;
        const lines = [
            `[도착지 위치 안내]`,
            `• 코드: ${code}`,
            `• 지역: ${info.kr || '-'}`
        ];
        if (info.en) {
            lines.push(`• 영문: ${info.en}`);
        }
        const tooltip = lines.join('\n').replace(/"/g, '&quot;');
        return `<span class="dest-code-item" data-code="${code}" title="${tooltip}" ondblclick="window.openDestinationQuickEdit('${code}', event)" style="cursor: help;">${code}</span>`;
    };

    if (!isMismatch || orig === null) {
        return makeSpan(val, valInfo);
    }

    return `
        <div class="mismatch-box">
            <span class="mismatch-orig">${makeSpan(orig, origInfo)}</span>
            <span class="mismatch-arrow">↓</span>
            <span class="mismatch-down">${makeSpan(val, valInfo)}</span>
        </div>
    `;
}

/**
 * 목적지 관리 UI 렌더링
 */
function renderDestinationSettings(filterKeyword = '') {
    const tbody = document.getElementById('destinationSettingsBody');
    const countEl = document.getElementById('destTotalCount');
    if (!tbody) return;
    tbody.innerHTML = '';

    const kw = (filterKeyword || '').trim().toUpperCase();
    const entries = Object.entries(destinationMap).sort(([a], [b]) => a.localeCompare(b));

    const filtered = entries.filter(([code, item]) => {
        if (!kw) return true;
        const kr = typeof item === 'string' ? item : item.kr;
        const en = typeof item === 'string' ? '' : (item.en || '');
        return code.includes(kw) || kr.toUpperCase().includes(kw) || en.toUpperCase().includes(kw);
    });

    if (countEl) countEl.textContent = filtered.length;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#94a3b8; padding:20px;">일치하는 목적지 코드가 없습니다.</td></tr>`;
        return;
    }

    filtered.forEach(([code, item]) => {
        const kr = typeof item === 'string' ? item : item.kr;
        const en = typeof item === 'string' ? '' : (item.en || '');
        const isCustom = !DEFAULT_DESTINATION_MAP[code] || DEFAULT_DESTINATION_MAP[code].kr !== kr;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="font-weight: 700; color: #1e293b; font-family: Consolas, monospace;">${code}</td>
            <td style="color: #0f172a; font-weight: 600;">${kr} ${isCustom ? '<span style="font-size:0.68rem; background:#ecfdf5; color:#059669; padding:1px 4px; border-radius:3px; margin-left:4px;">사용자수정</span>' : ''}</td>
            <td style="color: #64748b; font-size: 0.8rem;">${en || '-'}</td>
            <td style="text-align: center; white-space: nowrap;">
                <button class="btn btn-primary btn-edit-dest" data-code="${code}" style="padding: 2px 6px; font-size: 0.75rem; border-radius: 4px; margin-right: 4px;">수정</button>
                <button class="btn btn-danger btn-delete-dest" data-code="${code}" style="padding: 2px 6px; font-size: 0.75rem; border-radius: 4px;">삭제</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // 수정 버튼
    tbody.querySelectorAll('.btn-edit-dest').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const code = e.currentTarget.getAttribute('data-code');
            const item = destinationMap[code];
            const kr = typeof item === 'string' ? item : item.kr;
            const en = typeof item === 'string' ? '' : (item.en || '');

            document.getElementById('editDestOriginalCode').value = code;
            document.getElementById('inputDestCode').value = code;
            document.getElementById('inputDestNameKr').value = kr;
            document.getElementById('inputDestNameEn').value = en;

            document.getElementById('btnAddDest').style.display = 'none';
            document.getElementById('btnUpdateDest').style.display = 'inline-block';
            document.getElementById('btnCancelDestEdit').style.display = 'inline-block';
            document.getElementById('inputDestNameKr').focus();
        });
    });

    // 삭제 버튼
    tbody.querySelectorAll('.btn-delete-dest').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const code = e.currentTarget.getAttribute('data-code');
            if (confirm(`'${code}' 목적지 매핑을 삭제하시겠습니까? (삭제 시 기본값 또는 국가명으로 자동 표시됩니다)`)) {
                delete destinationMap[code];
                saveDestinationMap();
                renderDestinationSettings(document.getElementById('searchDestKeyword')?.value || '');
                if (typeof window.reCompareFilteredData === 'function') window.reCompareFilteredData();
            }
        });
    });
}

function resetDestInputs() {
    document.getElementById('editDestOriginalCode').value = '';
    document.getElementById('inputDestCode').value = '';
    document.getElementById('inputDestNameKr').value = '';
    document.getElementById('inputDestNameEn').value = '';

    document.getElementById('btnAddDest').style.display = 'inline-block';
    document.getElementById('btnUpdateDest').style.display = 'none';
    document.getElementById('btnCancelDestEdit').style.display = 'none';
}

// 퀵 등록/수정 팝업창
window.openDestinationQuickEdit = (code, e) => {
    if (e) e.stopPropagation();
    const info = getDestinationInfo(code);
    const newKr = prompt(`[도착지 ${code} 명칭 등록/수정]\n해당 5자리 코드의 한국어 지역명을 입력하세요:`, info.isKnown ? info.kr : (COUNTRY_CODE_MAP[code.substring(0, 2)] ? `${COUNTRY_CODE_MAP[code.substring(0, 2)]} ` : ''));
    if (newKr !== null && newKr.trim() !== '') {
        const cleanKr = newKr.trim();
        const existing = destinationMap[code] || {};
        destinationMap[code] = {
            kr: cleanKr,
            en: existing.en || `${code.substring(0, 2)} Port / Hub`
        };
        saveDestinationMap();
        alert(`✅ [${code}] 도착지가 '${cleanKr}'(으)로 등록/수정되었습니다!`);
        // 테이블 즉시 리렌더링
        if (typeof displayResults === 'function' && typeof comparisonResult !== 'undefined') {
            displayResults(comparisonResult, false);
        }
    }
};

// 초기화 이벤트 연결
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', async () => {
        await loadDestinationMap();

        // 모달 열기 버튼
        const destModal = document.getElementById('destinationSettingsModal');
        const btnOpenDestSettings = document.getElementById('btnOpenDestSettings');
        const closeDestModalBtn = document.getElementById('closeDestModalBtn');
        const closeDestModalBottomBtn = document.getElementById('closeDestModalBottomBtn');
        const searchDestKeyword = document.getElementById('searchDestKeyword');

        if (btnOpenDestSettings) {
            btnOpenDestSettings.addEventListener('click', async () => {
                await loadDestinationMap();
                renderDestinationSettings();
                if (destModal) destModal.style.display = 'block';
            });
        }

        if (closeDestModalBtn) closeDestModalBtn.addEventListener('click', () => { if (destModal) destModal.style.display = 'none'; });
        if (closeDestModalBottomBtn) closeDestModalBottomBtn.addEventListener('click', () => { if (destModal) destModal.style.display = 'none'; });

        if (searchDestKeyword) {
            searchDestKeyword.addEventListener('input', (e) => {
                renderDestinationSettings(e.target.value);
            });
        }

        // 추가 버튼
        document.getElementById('btnAddDest')?.addEventListener('click', () => {
            const code = document.getElementById('inputDestCode').value.trim().toUpperCase();
            const kr = document.getElementById('inputDestNameKr').value.trim();
            const en = document.getElementById('inputDestNameEn').value.trim();

            if (!code || !kr) {
                alert("목적지 코드(5자리)와 한국어 지역명을 입력해주세요.");
                return;
            }

            destinationMap[code] = { kr, en: en || `${code.substring(0, 2)} Area` };
            saveDestinationMap();
            renderDestinationSettings(searchDestKeyword ? searchDestKeyword.value : '');
            resetDestInputs();
            alert(`목적지 [${code}] 이(가) 등록되었습니다.`);
            if (typeof window.reCompareFilteredData === 'function') window.reCompareFilteredData();
        });

        // 수정 완료 버튼
        document.getElementById('btnUpdateDest')?.addEventListener('click', () => {
            const origCode = document.getElementById('editDestOriginalCode').value;
            const code = document.getElementById('inputDestCode').value.trim().toUpperCase();
            const kr = document.getElementById('inputDestNameKr').value.trim();
            const en = document.getElementById('inputDestNameEn').value.trim();

            if (!code || !kr) {
                alert("목적지 코드와 한국어 지역명을 입력해주세요.");
                return;
            }

            if (origCode && origCode !== code) {
                delete destinationMap[origCode];
            }

            destinationMap[code] = { kr, en: en || `${code.substring(0, 2)} Area` };
            saveDestinationMap();
            renderDestinationSettings(searchDestKeyword ? searchDestKeyword.value : '');
            resetDestInputs();
            alert(`목적지 [${code}] 이(가) 수정되었습니다.`);
            if (typeof window.reCompareFilteredData === 'function') window.reCompareFilteredData();
        });

        // 취소 버튼
        document.getElementById('btnCancelDestEdit')?.addEventListener('click', resetDestInputs);
    });
}
