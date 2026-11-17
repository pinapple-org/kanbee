import { inviteJoinNextStep } from '../joinResult'

describe('inviteJoinNextStep', () => {
  it('asks for email confirmation when signUpJoin answers without a token (MAIL_URL configured)', () => {
    expect(inviteJoinNextStep({ token: undefined })).toBe('confirmEmail')
  })

  it('asks for email confirmation when the token is missing from the answer', () => {
    expect(inviteJoinNextStep({})).toBe('confirmEmail')
  })

  it('opens the workspace when the answer carries a token', () => {
    expect(inviteJoinNextStep({ token: 'eyJhbGciOiJIUzI1NiJ9.test' })).toBe('openWorkspace')
  })
})
