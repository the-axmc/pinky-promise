// Host-side stand-in for the Arduino core: declarations only, for a syntax/type check.
#pragma once
#include <climits>
#include <cstddef>
#include <cstdint>
#include <cstring>
typedef uint8_t byte;
typedef bool boolean;
#define HIGH 1
#define LOW 0
#define INPUT_PULLUP 5
#define OUTPUT 3
#define SERIAL_8N1 0x800001c
class String {
 public:
  String(const char *text = "");
  String(const char *text, unsigned int length);
  String(const String &other);
  String &operator=(const String &other);
  String &operator=(const char *text);
  bool reserve(unsigned int size);
  String &operator+=(char c);
  String &operator+=(const char *text);
  bool concat(const char *text);
  bool concat(const char *text, unsigned int length);
  bool concat(char c);
  unsigned int length() const;
  const char *c_str() const;
};
class Print {
 public:
  virtual ~Print() {}
  virtual size_t write(uint8_t) = 0;
  virtual size_t write(const uint8_t *buffer, size_t size);
  size_t write(const char *buffer, size_t size);
  size_t print(const char *);
  size_t print(const String &);
  size_t print(char);
  size_t print(int);
  size_t print(unsigned int);
  size_t print(long);
  size_t print(unsigned long);
  size_t println(const char *);
  size_t println(const String &);
  size_t println(void);
  virtual void flush() {}
};
class Stream : public Print {
 public:
  virtual int available() = 0;
  virtual int read() = 0;
  virtual int peek() = 0;
  size_t readBytes(char *buffer, size_t length);
};
class HardwareSerial : public Stream {
 public:
  explicit HardwareSerial(int uart);
  void begin(unsigned long baud, uint32_t config = SERIAL_8N1, int8_t rxPin = -1, int8_t txPin = -1);
  int available() override;
  int read() override;
  int peek() override;
  size_t write(uint8_t) override;
  using Print::write;
  explicit operator bool() const;
};
extern HardwareSerial Serial;
unsigned long millis();
void delay(uint32_t ms);
void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t value);
int digitalRead(uint8_t pin);
bool psramFound();
void neopixelWrite(uint8_t pin, uint8_t red, uint8_t green, uint8_t blue);
class Printable {
 public:
  virtual ~Printable() {}
  virtual size_t printTo(Print &p) const = 0;
};
