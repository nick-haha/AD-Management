package ad

import "errors"

var (
	ErrNotFound       = errors.New("ad user not found")
	ErrInvalidInput   = errors.New("invalid input")
	ErrUnsafePassword = errors.New("password does not meet the local policy")
)
