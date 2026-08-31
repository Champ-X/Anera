export const ARENA_PARITY_V2_TASK_VERSION = '2.0' as const

export const ARENA_PARITY_V2_TASK_IDS = [
  'A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08',
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06',
  'D01',
  'F01', 'F02', 'F03', 'F04', 'F05', 'F06',
  'G01', 'G02', 'G03', 'G04',
  'I01', 'I02', 'I03', 'I04', 'I05',
  'K01', 'K02',
  'L01', 'L02', 'L03', 'L04', 'L05', 'L06',
  'M01', 'M02', 'M03', 'M04', 'M05', 'M06',
  'P01', 'P02', 'P03', 'P04',
  'R01',
  'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07',
  'U01', 'U02', 'U03',
  'V01',
  'W01', 'W02', 'W03', 'W04', 'W05',
] as const

export type ArenaParityV2TaskId = (typeof ARENA_PARITY_V2_TASK_IDS)[number]

export const ARENA_PARITY_V2_AF_IDS = numberedIds('AF', 16)
export const ARENA_PARITY_V2_H_IDS = numberedIds('H', 57)

export const ARENA_PARITY_V2_VIEWPORT = {
  widthPx: 1440,
  heightPx: 900,
  zoomPercent: 100,
} as const

export const ARENA_PARITY_V2_COVERAGE_STATUSES = [
  'observed_succeeded',
  'observed_attempted',
  'trigger_opportunity_not_observed',
  'requested_not_used',
  'unsupported',
  'blocked_by_policy',
  'failed',
  'not_visible',
  'not_captured',
] as const

export type ArenaParityV2CoverageStatus = (typeof ARENA_PARITY_V2_COVERAGE_STATUSES)[number]

export const ARENA_PARITY_V2_OPERATOR_ACTIONS = [
  'message_submit',
  'message_submit_attempt',
  'ask_user_submit',
  'ask_user_dismiss',
  'plan_revise',
  'plan_accept',
  'plan_reject',
  'stop',
  'retry',
  'continue',
  'resume',
  'refresh',
  'approval_approve',
  'approval_deny',
  'task_review_yes',
  'task_review_no',
  'task_review_continue',
  'task_review_dismiss',
  'task_completion_yes',
  'task_completion_no',
  'task_completion_making_progress',
  'attachment_select',
  'attachment_paste',
  'attachment_drop',
  'attachment_remove',
  'connections_open',
  'connections_close_escape',
  'connections_close_outside',
  'artifact_open',
  'artifact_download',
  'workspace_download',
  'preview_open',
  'preview_interact',
  'website_restart',
  'new_chat',
  'history_open',
  'voice_play',
  'voice_select',
  'image_select',
  'deploy',
  'repository_select',
] as const

export interface ArenaParityV2InputFileSpec {
  logicalId: string
  bytes: number
  sha256: string
  mimeType: string
}

export interface ArenaParityV2InputVariant {
  id: string
  files: readonly ArenaParityV2InputFileSpec[]
}

export interface ArenaParityV2OperatorVariant {
  id: string
  /** Ordered subsequence which must occur in the captured operator actions. */
  requiredActions: readonly string[]
}

export interface ArenaParityV2TaskSpec {
  taskId: ArenaParityV2TaskId
  taskVersion: typeof ARENA_PARITY_V2_TASK_VERSION
  /** SHA-256 of the exact normalized task section in ARENA_MANUAL_PROBE_RUNBOOK.md. */
  taskSpecSha256: string
  /** SHA-256 of the canonical ordered user-prompt protocol extracted from that section. */
  promptSha256: string
  inputVariants: readonly ArenaParityV2InputVariant[]
  operatorVariants: readonly ArenaParityV2OperatorVariant[]
}

/*
 * These hashes are generated from the repository's one frozen v2.0 task source,
 * ARENA_MANUAL_PROBE_RUNBOOK.md. A regression test recomputes every value from
 * the real task sections and prompt blocks. They are intentionally literal so
 * a production evaluator does not depend on a mutable working-copy Markdown
 * file at runtime.
 */
export const ARENA_PARITY_V2_TASK_SECTION_SHA256: Readonly<Record<ArenaParityV2TaskId, string>> = Object.freeze({
  A01: '2360d3a3593b12edb2880bb59c4e4232542dd73b399988a1788097b97af3b637',
  A02: '458e4a838f9fe042c0e84376fa7bc8bed469028a0514f14b6461eb0b5bdbb35c',
  A03: '734ce5803bcad18a4ff1dae2c6146c81632b5b39eb3bdbc1f3acc3356237498b',
  A04: 'ec9f706996bcc1cf3d6aac6d6d93d2959c5cabc4efb20c3e8abacab511abff0a',
  A05: 'b0f7d2dfebfa3f7ef1d767a1e25455e0bce2bc97a6c361e533e006dd87c77a2b',
  A06: '3240942d80dae8880428a29f7c604e5a908e1c5c91e88778c6a1c9dcaf698cf9',
  A07: 'f5ddb6be44f124878b3e166680868ba77cf499981a70652a3f3cdeba8cb0ef49',
  A08: 'beb2ecf7f63cbe6b02abd7aea700e1c70819d65ba9c8cbd2ecf2ac1529e603d8',
  C01: '050736f8ddab8f122a796dc3ae15c97ab49f4effbd645ebcd5ade5637ebac830',
  C02: '987f4922d1a73a6134e17747b7f8d9a5a2e295c3a552d8f3d51df52bf53a1d44',
  C03: '67f56ad266b208f0dcd713b7bfe5a605e34d7a0d0acb99c8a58f3dc08610c7cb',
  C04: 'ac4424917db382dbe2a2b923af543ff39a87a8239fd8e9a767c6f4fbdfb15802',
  C05: '1f81ade916425aac2e825e4f43f1ab09c3763f29cded27cb5ae093eb979b1fe3',
  C06: 'f08365c5303a3bc7cae7a8f9b8e6815771e7748353c9b2329224711b7fb390af',
  D01: 'fc4bf2f4f2ccf68892a61e2f5af9bbde555319ef12ea305e9101da7c7c1c673a',
  F01: 'aebc9807f24861e23ce898615800dc55a2736086b792e63f32883b40631c5df3',
  F02: '620e685f87d2c359d96c960e41b946cb38c78ed5045b21b20ecd86684e48e189',
  F03: 'd84d311ff09d57be19a42be94814b411e36632f64ea40247c22938c736f16a98',
  F04: '971f9df37ca4d469ed11b8fd680911f26f37fe342f33ffbbb845920e955f34dc',
  F05: 'e4906a808eb41f3994fb4eec3988578d03275694e9dcb577609eed3d04adf3df',
  F06: 'bc433fb717cec54e9b8c751a29fa8d977ea08bf40bb61e1f86e1f6555387195e',
  G01: '7a1e1197cac06adce51e63c274ec6f15ee420d56d5f15d5a56489aa55612c80b',
  G02: '4e88e4917836a3ca0558f4d644a2fa3dcad61ead7030c512bab27b21bea6d1cf',
  G03: '2d15bf0efac46db82511457acdf2d1914a20961f6fc39ba2afa2198ace05c536',
  G04: 'f5aa6a94655eb3ffc0ebf0127bd348754163ce97fd00caf4bc406b68bc26fdf6',
  I01: 'e66972e203985366df881efe8a5d1294e961f5a5fe7547554c13bbad582cf46a',
  I02: '3e52c6039174c44ed4ad721e893600084b07845bf31a6d24f9915b448219f31b',
  I03: 'cd700a4ea77493143dffebf6d949c0e696c0d642414f8dbee354baa069238663',
  I04: '4287bdceb110d25358a8ad4f92dc98ee6b53bfd32ec2beff91bf5523e65f5d3b',
  I05: '3d3f867880484aaf4ecd150c4a4da2c8ad70ce48f5fdc4d82043edf0468d4761',
  K01: '00b6a6d98e997bcb314162b774a786fe278d4b8ceabcb5a534d081f1620c5e21',
  K02: 'b3e4c420f1d82dd4965869da93feb6ea6d05db23c3416773788ad4b32377fdc4',
  L01: '39704b118145f4077f62c30c3c57a094f77b8dd346663ed3f4c50b312407037f',
  L02: 'd9b5bf6b9e531b0c6bd451256db0a64fa22f3c42938ca67ffac8d2e667952e2d',
  L03: 'd57b5217dbb337b847fb3b6eba536e9dcb7e09e4e7298dc352f2b9b8aa460331',
  L04: '53b475493abd0d8ae6395072bdbf1a88c60ffe90f29c86a508711dc899a80a51',
  L05: '2af642844f99e9b4822c0e6f911bde092dc7d9a7c848751b054fd485d87b311f',
  L06: 'a9d646edcd287ab0d243cd4414ab226328e1563b812dae679b3f5cbc3e51d202',
  M01: '752ae0234450e45ffe7615dca889106d133c87acbe28e7999d89e907b92f7ecf',
  M02: 'fc1bd6206f587b4814ca27ef9e39b13b59604c23e5346790a122c5dbb8697ece',
  M03: 'e0f47def7567f05e01acfd163d35b75f739b279fda5358dfd0c5152582963656',
  M04: 'ab730ccc02b485c5e6d2ba08bd0ccc498d26e9dec7c81d89c3c234a489ce4e22',
  M05: 'c5a43afe1b12bcf08bc7254bec840e019fa2d9bd5e4d28ec92ab2396a18694eb',
  M06: 'b8c7d1f4be0fc8e2e06011f72952d39e16636e7de01196b8f85833b95efa9eb8',
  P01: '1ba2d16114a57f195c524d72f526e9ee2f40768df8db6f32511ba8be7f77a14e',
  P02: 'b1f9c80ea8af9d7607f8b9a49930e38c6e8ec8a0456b718a8f4f5b417ba0b3dc',
  P03: '1f535a799ce6efe7a41d0ababb8eb190ca0e351b0304de076b1764214302886e',
  P04: 'fa8a0486b4c08b8360e1b37641eb45c785ec52ef31e2f9529f09756dd13d874f',
  R01: 'd97c63fc523510552421d52b4dfcaf9c1686cd0190e35b5f4658e436497a31db',
  S01: 'a8c6bb8b5af0d6452e37155da56909ac38a093c98f41def160b717298bfa7258',
  S02: '1e5f74d73c0258ae43aaaa6ec0d17ef1ca11a6fad2e8673bfa2d60d2be76ece0',
  S03: '136ed947dafd33fd79e37f1b8cb9a980cf27cc6ea0401f7d28518f006e5d00b1',
  S04: 'b97f6a9857964d97bc506d2db9a160f5273ff17618815ab8f5df67f5618dd08f',
  S05: 'b4f89dcd575fa52a819e8aee2775a54e1ff30e7b5992f263f4839ccd5c8dd75b',
  S06: '679ef26a8e041ff0509da41dcd60f6dd3eb705df20b31d6f896e8c6f9f71ec20',
  S07: 'dd547ce9696be74a85fbc6242693a0fecc5edc268a0ac1ac289a3f8acaf598f6',
  U01: 'feeda697c761ddf433538e9aaad50269aa2455ca56bd6e3a669bdf4408c17324',
  U02: 'ca3b5f01dadcbc1ef4a88572e2c54e76a32f01aefa6415147a2ea5d413beaa69',
  U03: '8d03db1617794b3a8485c05a54010d67dd5c9612ef31b4711086aaa3c573600e',
  V01: 'fc5b542fc43d40c51798b2967860ac08274360fba5e25525d4d1499870d6883e',
  W01: 'd7c4caa5afb81a6006668d474c082ba7017ddaaaaa392ec7c58050890c2059ab',
  W02: '0da5198031389bb55e8251817731d2345fca94af971847a872c97b2188f7a65a',
  W03: '7bd807e1359fea6943b6a6767dd0bf71e9779487ef0bb61e5234f5ccf7a0b73d',
  W04: '07ff6e7e38e4678b6fe3fbd01185789602e4dbddcff7fb0efbf62814f2650555',
  W05: '9f0cf53bcfdae53359391cbb9ba055a13bb46e04f9ddd55474eb7ea58751cfb2',
})

export const ARENA_PARITY_V2_PROMPT_PROTOCOL_SHA256: Readonly<Record<ArenaParityV2TaskId, string>> = Object.freeze({
  A01: '667f6604b40b1964ad82255e7095b8d158b60967ef876f868ace36d13d371444',
  A02: '31d5a959df541b5368c296cced8ace6c0b7df657c6b9073f7eb99fef5e02f5a8',
  A03: 'd37b6ba40beb17be9bd08e7cdacbd3d005e3cce0172bcf6fdf52bfefc12313d8',
  A04: 'afed4a72f080f817fd6f4ff1fe93788f12f1ac93345b6738b9d147a501685bae',
  A05: '315e42d1571c004ec0a10126f9638dc85c250ca430bb1e9b78cc0eac0d4160c5',
  A06: '7a8b889ed82ddb61e7ceac3452d9eb9efc9e1558fb8db7150051d951d5df8c31',
  A07: '4a668a5fccebfcfb4bcb1e53bd6048be13532138b2977bf8ea21aff7ef092886',
  A08: '8d49c80eabe2a194a34b345bf6fb404c4167974864a7f1f0c0697c266a16ddee',
  C01: 'f3966afc1be2cadfc9d5530807056854128e12159a4002358656916ced145318',
  C02: '67e1e13b1872ff5e24800b45308944cc0e537fdc254dec83b0da2330fc516335',
  C03: '9f10779d79215de4d9c62ae2af24784440646865da99c43fd53d1f1d1fe71475',
  C04: '5a63a6e049c74455a724df12294e67125ee989318e0f6880d2a68ec748c3f035',
  C05: 'bcaf69e444af2ca2141c5155c3e305737d27f58eaaad316bf35f26b6bfa8ae65',
  C06: '80f07e4774a52561e5d420966061e428af2132e470b523e0fc209c97e47b0a6d',
  D01: 'fa1daf4368df9ced22adb8a266f1ca64d325798efa6dd3ec5248b64f16eaa127',
  F01: '2f626deb78cd2ba9c12636146014296b4546362d328e0e1316f7a76f0739de3b',
  F02: '99457a2b728fb7c2fc3dc18a99f86bbe392c6d65a5d4fb6f90f00df2cf54559c',
  F03: '86e41deeb355ba2817fdd2d82750fcd23deab3d56e6dd679666865301c71e188',
  F04: 'db8c9b5bf5413c0d3f6ef6d54ebbf8ae9ba5dfb4ef5e31d42b347820565d13f7',
  F05: 'b0601ea36bacd961aa3cb25f26b17c2acb07c8ebc40a2cab76ca02a508c678c8',
  F06: '4df6a248262cd08bcb8cfbafa9ad713a3921396b3000a1e4c992a6726b017515',
  G01: '1d8cdaed4c300ce4c000f9deed43d2f8ac4cc00e1ea7b898bdb8231c6f6427fe',
  G02: '1005d5a5051671ac3070f036eacf2c482d777ec54c7a4a69cf3af4e6f34a19cc',
  G03: '3f78d07ff7e3bd79aa5d8c0774c9ff2e414f1d9ad7d19bcec0f41d54e7eed4e0',
  G04: '347d37eaebad3d5087b593e8c8dbfddbdaedb7987a018825fef783da5eaba594',
  I01: '329d5c98b7145b98d73630ff55d7b39f90b52e1603e9065d7f7cdd4defb737a8',
  I02: '2949247712d57768df672d086ed9d0c45771ffcf26cfb00dccee5d548c0df71b',
  I03: 'e4a9a61b2feb7570c9c153f54ab4561d77fed429399eeff03c844075585bcdb3',
  I04: '585d30281225c3f0faefe16313842d626647fa7349aa063515f5cb90dce1e291',
  I05: '8642b2daf4dd525b73cc2ddf8cd6dd978956746b3d57514233bc4a7adbdc7f31',
  K01: '0f15e0248328e2efffa6a3005d80c05a8b0caf21c75c806e6b52cafb55943dd5',
  K02: 'b7d4e04d252b2381997c3b98f3f22e7dcfc12e888960d2cc1bb048e059c9e2f6',
  L01: 'f1f9882db0a4fc40cdc04c18c2a51226ede0bbe1adc808538311f077464bc51b',
  L02: '081317286981140c0c0a2f2872a517d1762b7d066ef5a5856a0fd54c966f576e',
  L03: '442210390a5ee2999cfeefe814030466520606d56ba16719f06ee76538d63c89',
  L04: 'bab2b06f717ff14442e70d9dcadda3bc1f16ee77f92d345e561ba8058606164b',
  L05: '8a30ec309f92bd4abc353e3521c5c84108912b8775a700cc94aae31a443da017',
  L06: 'ab35ded8ce877b2979efe823c240446716e8a4bc55cdff8c8371c03112a972c1',
  M01: 'bf57e0c21f890f245025b63bafa7404c41636400e010cd1aae5e016b955e9492',
  M02: '1b3d69a365afeaaecdd177bf75af2bcf263b2af7d6e2f8cb88d082e7767f9425',
  M03: '6f206398a78a13693084fef2cb6fe49184deb77940e3950dbd3d91f6ed7ece2b',
  M04: 'f198058ffc0350070b44afdbe32ff5ca947fae06cd002f94fbf679cb032610e7',
  M05: 'eec1dcb4a480e8b0e0165a5b3122854e346967eef1aa92837e3772fce845ae4e',
  M06: '3824b71ffa7209c17d1ef7b2b21a983a1772171db6b2fc9ce31cdf9b4040cc77',
  P01: '8ffdf26cb5286afd03a6f2d22318bb9ca5e0213c89ccd10c9394f99b85471785',
  P02: 'd66cc51125c095b91b347419196fd1a578037526766fc58771cf8d9aeee7c85d',
  P03: 'b121bc7033d26a4af70200e505feca58385c94254e86e192e27c512723da2cb1',
  P04: '4bd5260a3da5e200e8cdc73813e072024b9959aaedaad5dd55a00fa9d91a7946',
  R01: '5d461ae26312c1605613abd67bd0f73f5e93a09bd2072227684a55a6b85c5b86',
  S01: '1a45ec58e6e1a053f7cbc7d4d929d9dab8a6ba1163970c7edd301bca1c288807',
  S02: '827ac21c7a46d2fada5e284b69f7b71ba6de2ecc6ba0cb77555fa9724c6dcb3d',
  S03: 'c42d7013df1ad56868cd36e2935e9164ec683c147b2a4493a0e3769a5c9b8307',
  S04: 'ef3075b23bbae13ffcef7a5e66366c225bc3e3e263b0a05ce2303c9a9389e62b',
  S05: '046077ca384fa4be03c4671ecc0cfb6ef4b65fb48458b551f7a550e9f23ddd9c',
  S06: 'a92809324bb687e7216adf9ab979a65348f18d79965ac1de5bd7ba9968adf38f',
  S07: 'de081ececaf766eb2d85ffa4da580f68c7732249a5dc9d2e48963b20e611f5cf',
  U01: '78631580f6da4f4e7239a1d37279cddde18d17a7f7b9805a08a14edc2673e313',
  U02: 'f23ae363a47926bff84c506b7511b98160c4aa8048b3e67a0ec4555d1cfebf1d',
  U03: '7f7a3f5cf0e68455605b456023d70a736c8f3401b916549191e625ec44a19c95',
  V01: 'f18561b007794c877c9e980d7d95a9ef25a60f22b29736453b836efd85ec528f',
  W01: 'da0f8b38c826969e0d83b9e913e00d92a5938d7636d4a865b23b2869ebc8e8a1',
  W02: 'ab7e4033d8a0dd53d9f308109910b88f43755d3631ab26d4032a948e8f23f017',
  W03: 'fb841c9672cda75ec55280a428390c33a3ca6a7d17361700b6c0d9d72a74e93e',
  W04: '173244a5ebce01bb2fad5a28bafe23b8756f78f8005d46a831efa6ff05042cde',
  W05: 'b8d695099dfdefa68f390320d025a67063db058d41aa76972dc21da62100c73d',
})

const INPUT_FILE = Object.freeze({
  F01_HTML: file('F01-I01', 854, '150a2cdc637660009fd31a0bd7ff6ddb5a4954449edd1784474d9b76f102f9f9', 'text/html'),
  I01_TEXT: file('I01-I01', 32, 'fa930c1f54ea98ffce7e41a4c784257d21602ca88630e0c5c2c8183f603c82ea', 'text/plain'),
  UI_PNG_I02: file('I02-I01', 107_041, '0e065a86b40e1d95c8ce16b61256232b1b48ef372497ecd3bf804cc3e5cde288', 'image/png'),
  I03_HTML: file('I03-I01', 854, '150a2cdc637660009fd31a0bd7ff6ddb5a4954449edd1784474d9b76f102f9f9', 'text/html'),
  I03_DOCX: file('I03-I02', 1_865, 'e53dd6ba5a41864cd0fa159b619c598999c9f5917b095618420b08841a90eed7', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  I04_BIG_TEXT: file('I04-I01', 26_214_401, '0765445211e5f3faf9378e5dd89603fe38c13f5863158906ece6fd1369631087', 'text/plain'),
  I04_BIG_PDF: file('I04-I02', 10_485_761, '0c2725e0d4ae4ae669bdd6c88b253997198efb67d962d217c52e6cbfd318fe0c', 'application/pdf'),
  I04_A: file('I04-I03', 20_971_520, 'cd52d81e25f372e6fa4db2c0dfceb59862c1969cab17096da352b34950c973cc', 'text/plain'),
  I04_B: file('I04-I04', 20_971_520, 'cd52d81e25f372e6fa4db2c0dfceb59862c1969cab17096da352b34950c973cc', 'text/plain'),
  I04_C: file('I04-I05', 10_485_761, '0c2725e0d4ae4ae669bdd6c88b253997198efb67d962d217c52e6cbfd318fe0c', 'text/plain'),
  RFC_L04: file('L04-I01', 2_858_365, '60b30efa1048900833d1758440247fe8ac85a3134f2327388dcb24e07d814c89', 'application/pdf'),
  UI_PNG_M01: file('M01-I01', 107_041, '0e065a86b40e1d95c8ce16b61256232b1b48ef372497ecd3bf804cc3e5cde288', 'image/png'),
  RFC_M02: file('M02-I01', 2_858_365, '60b30efa1048900833d1758440247fe8ac85a3134f2327388dcb24e07d814c89', 'application/pdf'),
  M03_MD: file('M03-I01', 4_014, '79183c0aa4cb4736227e4574198503aec1971159ed34b3b694f50e0948375e2a', 'text/markdown'),
  M04_CSV: file('M04-I01', 135, 'd345e0fa0a82542b3866a839683f6ab21a3ece0235f23233a60909508ad071cd', 'text/csv'),
  M04_RULES: file('M04-I02', 615, 'd8ebdedba72b026e3e2fb3d76ffc6cd09136557763125adc2a1eb091a7a73e27', 'text/markdown'),
  M06_DOCX: file('M06-I01', 1_865, 'e53dd6ba5a41864cd0fa159b619c598999c9f5917b095618420b08841a90eed7', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  M06_XLSX: file('M06-I02', 2_297, '339ec0853bf5b7af2fe4b75d50d6288c6f037fb4160ae9b554ac5949772834ea', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  M06_PPTX: file('M06-I03', 3_055, '73caacf5abd1a7a18f322945a61aa2bf02565c9e2e499f3bf74be34289406588', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
  UI_PNG_G04: file('G04-I01', 107_041, '0e065a86b40e1d95c8ce16b61256232b1b48ef372497ecd3bf804cc3e5cde288', 'image/png'),
  K01_README: file('K01-R01:README.md', 153, 'aed7bfbabb1981aedfc1f2674bb5cd82743e731916a2138d9ae96e43c4f2658d', 'text/markdown'),
  K01_PROBE_TS: file('K01-R02:src/probe.ts', 115, 'f3d060ed6a5e6434e435a0dde96d78e411cba5bd2d932c48de210087b9cac701', 'text/typescript'),
  K01_NUMBERS: file('K01-R03:data/numbers.csv', 29, 'e3d1fdf0316f05459415adf95da11721302ad0b7288750648028ad7d5877b41e', 'text/csv'),
})

const SPECIAL_INPUT_VARIANTS: Partial<Record<ArenaParityV2TaskId, readonly ArenaParityV2InputVariant[]>> = {
  F01: [input('fixture', INPUT_FILE.F01_HTML)],
  G04: [input('fixture', INPUT_FILE.UI_PNG_G04)],
  I01: [input('fixture', INPUT_FILE.I01_TEXT)],
  I02: [input('clipboard-source', INPUT_FILE.UI_PNG_I02)],
  I03: [input('html-then-docx', INPUT_FILE.I03_HTML, INPUT_FILE.I03_DOCX), input('docx-then-html', INPUT_FILE.I03_DOCX, INPUT_FILE.I03_HTML)],
  I04: [input('boundary-fixtures', INPUT_FILE.I04_BIG_TEXT, INPUT_FILE.I04_BIG_PDF, INPUT_FILE.I04_A, INPUT_FILE.I04_B, INPUT_FILE.I04_C)],
  K01: [input('private-repository-fixture', INPUT_FILE.K01_README, INPUT_FILE.K01_PROBE_TS, INPUT_FILE.K01_NUMBERS)],
  L04: [input('rfc9110-pdf', INPUT_FILE.RFC_L04)],
  M01: [input('fixture', INPUT_FILE.UI_PNG_M01)],
  M02: [input('rfc9110-pdf', INPUT_FILE.RFC_M02)],
  M03: [input('fixture', INPUT_FILE.M03_MD)],
  M04: [input('fixtures', INPUT_FILE.M04_CSV, INPUT_FILE.M04_RULES)],
  M06: [input('fixtures', INPUT_FILE.M06_DOCX, INPUT_FILE.M06_XLSX, INPUT_FILE.M06_PPTX)],
}

const SPECIAL_OPERATOR_VARIANTS: Partial<Record<ArenaParityV2TaskId, readonly ArenaParityV2OperatorVariant[]>> = {
  A01: [operator('check-in-yes', 'message_submit', 'task_review_yes', 'refresh'), operator('completion-yes', 'message_submit', 'task_completion_yes', 'refresh'), operator('feedback-not-visible', 'message_submit', 'refresh')],
  A03: [operator('ask-custom', 'message_submit', 'ask_user_submit'), operator('ask-option', 'message_submit', 'ask_user_submit'), operator('composer-answer', 'message_submit', 'message_submit'), operator('question-not-observed', 'message_submit')],
  A04: [operator('check-in-close', 'message_submit', 'task_review_dismiss', 'refresh'), operator('check-in-not-visible', 'message_submit')],
  A05: [operator('check-in-escape', 'message_submit', 'task_review_dismiss', 'refresh'), operator('check-in-not-visible', 'message_submit')],
  A07: [operator('automatic', 'message_submit'), operator('formal-continuation', 'message_submit', 'continue')],
  A08: [operator('ask-dismiss', 'message_submit', 'ask_user_dismiss'), operator('structured-ask-not-visible', 'message_submit')],
  D01: [operator('deploy-two-turn', 'message_submit', 'approval_approve', 'message_submit', 'deploy'), operator('deploy-no-approval', 'message_submit', 'message_submit', 'deploy'), operator('deploy-unavailable', 'message_submit')],
  F02: [operator('approved', 'message_submit', 'message_submit', 'approval_approve'), operator('approval-not-visible', 'message_submit', 'message_submit')],
  F04: [operator('denied', 'message_submit', 'message_submit', 'approval_deny'), operator('approval-not-visible', 'message_submit', 'message_submit')],
  G01: [operator('candidate', 'message_submit', 'image_select'), operator('direct-image', 'message_submit')],
  F01: [operator('attachment-and-send', 'attachment_select', 'message_submit')],
  G04: [operator('candidate', 'attachment_select', 'message_submit', 'image_select'), operator('direct-image', 'attachment_select', 'message_submit')],
  I01: [operator('attachment-and-send', 'attachment_select', 'message_submit')],
  I02: [operator('paste-and-send', 'attachment_paste', 'message_submit')],
  I03: [operator('drop-and-remove', 'attachment_drop', 'attachment_remove')],
  I04: [operator('boundary-sequence', 'attachment_select', 'attachment_select', 'attachment_select', 'attachment_remove', 'attachment_remove')],
  I05: [operator('popover-close-paths', 'connections_open', 'connections_close_escape', 'connections_open', 'connections_close_outside')],
  L01: [operator('two-turn', 'message_submit', 'message_submit')],
  L02: [operator('retry', 'message_submit', 'stop', 'retry'), operator('continue', 'message_submit', 'stop', 'continue'), operator('resume', 'message_submit', 'stop', 'resume'), operator('composer-recovery', 'message_submit', 'stop', 'message_submit'), operator('no-recovery', 'message_submit', 'stop')],
  L03: [operator('refresh-reached', 'message_submit', 'refresh'), operator('refresh-not-reached', 'message_submit')],
  K01: [operator('repository-and-send', 'repository_select', 'message_submit')],
  L04: [operator('attachment-five-turn', 'attachment_select', 'message_submit', 'message_submit', 'message_submit', 'message_submit', 'message_submit')],
  L05: [operator('send-attempt', 'message_submit', 'message_submit_attempt'), operator('second-turn-accepted', 'message_submit', 'message_submit'), operator('composer-unavailable', 'message_submit')],
  L06: [operator('three-turn', 'message_submit', 'message_submit', 'message_submit')],
  M01: [operator('attachment-and-send', 'attachment_select', 'message_submit')],
  M02: [operator('attachment-and-send', 'attachment_select', 'message_submit')],
  M03: [operator('attachment-and-send', 'attachment_select', 'message_submit')],
  M04: [operator('attachments-and-send', 'attachment_select', 'message_submit')],
  M06: [operator('attachments-rejected', 'attachment_select'), operator('attachments-accepted', 'attachment_select', 'message_submit')],
  P01: [operator('two-turn', 'message_submit', 'message_submit')],
  P02: [operator('two-turn', 'message_submit', 'message_submit')],
  P03: [operator('revise-accept', 'message_submit', 'plan_revise', 'plan_accept'), operator('plan-not-visible', 'message_submit')],
  P04: [operator('reject', 'message_submit', 'plan_reject'), operator('plan-not-visible', 'message_submit')],
  R01: [operator('check-in-no', 'message_submit', 'task_review_no', 'refresh'), operator('completion-no', 'message_submit', 'task_completion_no', 'refresh'), operator('feedback-not-visible', 'message_submit', 'refresh')],
  S05: [operator('stop-and-check', 'message_submit', 'stop', 'message_submit'), operator('stop-no-input', 'message_submit', 'stop')],
  S06: [operator('automatic-timeout-and-check', 'message_submit', 'message_submit'), operator('manual-stop-and-check', 'message_submit', 'stop', 'message_submit'), operator('manual-stop-no-input', 'message_submit', 'stop')],
  U01: [operator('workspace-download', 'message_submit', 'workspace_download'), operator('download-not-visible', 'message_submit')],
  U02: [operator('restart', 'message_submit', 'website_restart', 'preview_open'), operator('restart-not-visible', 'message_submit')],
  U03: [operator('review-continue', 'message_submit', 'new_chat', 'history_open', 'refresh', 'task_review_continue', 'refresh'), operator('completion-progress', 'message_submit', 'new_chat', 'history_open', 'refresh', 'task_completion_making_progress', 'refresh'), operator('history-unavailable', 'message_submit', 'new_chat')],
  V01: [operator('voice-selection', 'message_submit', 'voice_play', 'voice_select'), operator('voice-not-visible', 'message_submit')],
}

export const ARENA_PARITY_V2_TASK_SPECS: Readonly<Record<ArenaParityV2TaskId, ArenaParityV2TaskSpec>> = Object.freeze(Object.fromEntries(
  ARENA_PARITY_V2_TASK_IDS.map((taskId) => [taskId, Object.freeze({
    taskId,
    taskVersion: ARENA_PARITY_V2_TASK_VERSION,
    taskSpecSha256: ARENA_PARITY_V2_TASK_SECTION_SHA256[taskId],
    promptSha256: ARENA_PARITY_V2_PROMPT_PROTOCOL_SHA256[taskId],
    inputVariants: Object.freeze(SPECIAL_INPUT_VARIANTS[taskId] ?? [input('none')]),
    operatorVariants: Object.freeze(SPECIAL_OPERATOR_VARIANTS[taskId] ?? [operator('standard', 'message_submit')]),
  })]),
) as Record<ArenaParityV2TaskId, ArenaParityV2TaskSpec>)

export const ARENA_PARITY_V2_AF_TASKS: Readonly<Record<string, readonly ArenaParityV2TaskId[]>> = Object.freeze({
  AF01: tasks('I01', 'I02', 'I03', 'I04', 'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'G04', 'L04'),
  AF02: tasks('A01', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'R01'),
  AF03: tasks('P03', 'P04', 'W02', 'L02', 'L05'),
  AF04: tasks('A02', 'P01', 'P02', 'C05', 'L01', 'U01'),
  AF05: tasks('W01', 'W02', 'W03', 'W04', 'W05', 'C02', 'G02', 'G03'),
  AF06: tasks('S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'C04', 'U02'),
  AF07: tasks('C01', 'C02', 'C03', 'C04', 'C05', 'U02', 'D01'),
  AF08: tasks('C01', 'C02', 'C03', 'L03', 'M01', 'U02'),
  AF09: tasks('C06', 'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'G01', 'G02', 'G03', 'G04', 'V01'),
  AF10: tasks('F02', 'F04', 'I05', 'K01', 'K02', 'D01'),
  AF11: tasks('F01', 'F02', 'F03', 'F04', 'F05', 'F06'),
  AF12: tasks('A03', 'A08', 'P03', 'P04', 'S05', 'S06', 'S07', 'L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'U03', 'V01'),
  AF13: tasks('A01', 'A04', 'A05', 'A07', 'R01', 'U03'),
  AF14: tasks(...ARENA_PARITY_V2_TASK_IDS),
  AF15: tasks(...ARENA_PARITY_V2_TASK_IDS),
  AF16: tasks('R01', 'W04', 'C04', 'S02', 'S03', 'S04', 'S05', 'S06', 'L02', 'L03', 'L04', 'L05', 'F04', 'F05', 'I03', 'I04', 'M06'),
})

export const ARENA_PARITY_V2_H_TASKS: Readonly<Record<string, readonly ArenaParityV2TaskId[]>> = Object.freeze({
  H01: tasks('A01', 'A04', 'A05', 'F01'), H02: tasks('A03'), H03: tasks('A06'), H04: tasks('W02', 'W03', 'L02', 'C03'),
  H05: tasks(...ARENA_PARITY_V2_TASK_IDS), H06: tasks('W01', 'W02', 'W03', 'W04', 'W05'), H07: tasks('W03', 'W04'), H08: tasks('S01', 'S02', 'S03', 'S04'),
  H09: tasks('S05'), H10: tasks('S06'), H11: tasks('A02', 'C03', 'C06', 'U01'), H12: tasks('C05'), H13: tasks('C04'),
  H14: tasks('C01', 'C02', 'C03', 'L01', 'L03', 'M01'), H15: tasks('U02'), H16: tasks('U02'), H17: tasks('C06', 'M03', 'M04', 'M05', 'M06'),
  H18: tasks('U01'), H19: tasks('L01'), H20: tasks('L02'), H21: tasks('L03'), H22: tasks('L04'), H23: tasks('U03'), H24: tasks('F01', 'F06'),
  H25: tasks('F02'), H26: tasks('F04'), H27: tasks('F03'), H28: tasks('F05'), H29: tasks('M01', 'M02', 'M03', 'M04', 'M06', 'L04'),
  H30: tasks('M05'), H31: tasks('A01', 'S01', 'C06', 'M04'), H32: tasks(...ARENA_PARITY_V2_TASK_IDS), H33: tasks('A01', 'A04', 'A05', 'R01', 'U03'),
  H34: tasks('M06'), H35: tasks('P01'), H36: tasks('P02'), H37: tasks('P03'), H38: tasks('G02'), H39: tasks('G01', 'G04'), H40: tasks('D01'),
  H41: tasks('I01'), H42: tasks('I02'), H43: tasks('I03', 'M06'), H44: tasks('I04'), H45: tasks('A07'), H46: tasks('L05'), H47: tasks('I05'),
  H48: tasks('K01'), H49: tasks('A01', 'R01', 'U03'), H50: tasks('A03', 'A08'), H51: tasks('P03', 'P04'), H52: tasks('A02', 'P01', 'P02', 'U01'),
  H53: tasks('S07', 'U02'), H54: tasks('G03'), H55: tasks('V01'), H56: tasks('K01', 'K02'), H57: tasks('L06', 'A07', 'L04'),
})

export const ARENA_PARITY_V2_TOOL_TASKS: Readonly<Record<string, readonly ArenaParityV2TaskId[]>> = Object.freeze({
  add_voice: tasks('V01'), ask_user: tasks('A03', 'A08'), bash: tasks('S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'C04', 'C05'),
  compact: tasks('L06', 'A07', 'L04'), edit_file: tasks('P02', 'L01', 'D01'), fetch_page: tasks('W01', 'W04', 'W05'), generate_image: tasks('G01', 'G04'),
  generate_speech: tasks('V01'), get_process_output: tasks('S07', 'U02'), image_search: tasks('G03'), list_connector_tools: tasks('K02', 'K01'),
  list_files: tasks('P01', 'U01'), present_file: tasks('A02', 'C06', 'M05', 'V01'), propose_plan: tasks('P03', 'P04'),
  read_file: tasks('A02', 'P01', 'P02', 'G03'), start_process: tasks('S07', 'U02'), stop_process: tasks('S07', 'U02'), web_search: tasks('W02', 'W03'),
  write_file: tasks('A02', 'P01', 'P02', 'P03', 'C01', 'C02', 'C03', 'C04', 'C05', 'C06'),
})

function numberedIds(prefix: string, count: number): readonly string[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`))
}

function file(logicalId: string, bytes: number, sha256: string, mimeType: string): ArenaParityV2InputFileSpec {
  return Object.freeze({ logicalId, bytes, sha256, mimeType })
}

function input(id: string, ...files: ArenaParityV2InputFileSpec[]): ArenaParityV2InputVariant {
  return Object.freeze({ id, files: Object.freeze(files) })
}

function operator(id: string, ...requiredActions: string[]): ArenaParityV2OperatorVariant {
  return Object.freeze({ id, requiredActions: Object.freeze(requiredActions) })
}

function tasks(...taskIds: ArenaParityV2TaskId[]): readonly ArenaParityV2TaskId[] {
  return Object.freeze([...new Set(taskIds)])
}
