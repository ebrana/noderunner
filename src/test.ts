export function mockDateNow(date: string) {
  const now = new Date(date).getTime()
  Date.now = jest.spyOn(Date, 'now').mockImplementation(() => now)
}
