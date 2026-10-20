// 테스트 중 console.error(LWC 엔진 경고 포함)가 하나라도 나오면 실패 처리
// → org에서 보던 "Invalid template returned by render()" 같은 런타임 오류를 배포 전에 잡기 위함
const IGNORED = [/Not implemented: HTMLCanvasElement/]; // jsdom에 canvas 구현이 없어 생기는 잡음만 허용

beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation((...args) => {
        const msg = args.map(String).join(' ');
        if (IGNORED.some((re) => re.test(msg))) {
            return;
        }
        throw new Error(`console.error 발생: ${msg}`);
    });
});

afterEach(() => {
    jest.restoreAllMocks();
});
