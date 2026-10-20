# Built on the Pi against the SDRplay API installed in /usr/local (headers and libsdrplay_api.so).
CXXFLAGS ?= -O3 -ffast-math -mcpu=native -std=c++17 -Wall -Wno-unused-variable
sdr-engine: engine.cpp dsp.h rds.h
	$(CXX) $(CXXFLAGS) -o $@ engine.cpp -lsdrplay_api -lfftw3f -lpthread
clean:
	rm -f sdr-engine
