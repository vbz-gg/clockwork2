import type { Cw2TestApi } from "../../demo/src/testing/test-api"

declare global {
  interface Window {
    __cw2test?: Cw2TestApi
  }
}
