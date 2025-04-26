"use client";
import React, { createContext, useContext, useState, useRef, ReactNode, MutableRefObject } from 'react';
import { Block } from '@/types/blockTypes';

interface BlocksContextType {
  blocks: Block[];
}